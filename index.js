require('dotenv').config();
const http = require('http');

// Dummy server to bind to a port
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
});

// Listen on the port provided by Render, or default to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bot is running on port ${PORT}`);
});

const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

// Initialize the bot and provider
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const provider = new ethers.providers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);

const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
];

let walletList = {};
let userStates = {}; // To track user states (for adding or editing wallets)

// Start command that will show the wallet list with action buttons
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    // Initialize walletList for the chatId if not already set
    if (!walletList[chatId]) {
        walletList[chatId] = [];
    }

    await bot.sendMessage(chatId, 'Greetings!', {
        reply_markup: {
            keyboard: [
                [{ text: 'Add Wallet' }],
                [{ text: 'List Wallets' }],
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
    showWalletList(chatId);
    monitorTransactions(chatId);
});

// Function to show the list of wallets with buttons for Edit and Remove
async function showWalletList(chatId) {
    if (!walletList[chatId] || walletList[chatId].length === 0) {
        await bot.sendMessage(chatId, 'The wallet list is empty.');
        return;
    }

    for (const [index, wallet] of walletList[chatId].entries()) {
        let walletButtons = [];
        walletButtons.push([
            { text: 'Edit', callback_data: `edit_${index}` },   // Edit button
            { text: 'Remove', callback_data: `remove_${index}` }  // Remove button
        ]);

        const options = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: walletButtons
            }
        };
        await bot.sendMessage(chatId, "Wallet " + (index + 1) + "\n`" + wallet + "`", options);
    }
}

// Function to monitor transactions for each wallet address in the list
function monitorTransactions(chatId) {
    let lastTimeStamp = 0;
    // Listen for new blocks
    provider.on('block', async (blockNumber) => {
        // Get the block details
        const block = await provider.getBlockWithTransactions(blockNumber);

        if(block.timestamp > lastTimeStamp) {
            lastTimeStamp = block.timestamp;    //Prevent recapturing the same block

            const toAddresses = new Set(block.transactions
                .filter(tx => tx?.to)
                .map(tx => tx.to.toLowerCase())
            );

            for(const wallet of walletList[chatId].filter(fwallet => toAddresses.has(fwallet.toLowerCase()))) {
                const options = {
                    method: 'GET',
                    url: `https://feed-api.cielo.finance/api/v1/feed?wallet=${wallet}&chains=ethereum&txTypes=transfer&fromTimestamp=${lastTimeStamp}&toTimestamp=${lastTimeStamp}&includeMarketCap=true`,
                    headers: {
                        accept: 'application/json',
                        'X-API-KEY': process.env.CIELO_API_KEY
                    }
                };
                
                try {
                    const response = await axios.request(options);

                    if (!response.data.data.items.length) {
                        continue;
                    }

                    for (const item of response.data.data.items.filter(fitem => fitem.type === 'ERC20')) {
                        const tokenContract = new ethers.Contract(item.contract_address, ERC20_ABI, provider);
                        const balance = await tokenContract.balanceOf(wallet);

                        await bot.sendMessage(
                            chatId,
                            "**New Purchase!**\n" +
                            "**Wallet**:\n`" + wallet + "`\n" +
                            "**Token Address**:\n`" + item.contract_address + "`\n" +
                            "**Market Cap**:\n" + item.token_market_cap.market_cap + "\n" +
                            "**Position**:\n" + ethers.utils.formatUnits(balance, 18) + "\n" +
                            "**Tx**:\n" + 
                                "- Hash: " + item.tx_hash + "\n" +
                                "- Token Name: " + item.symbol + "\n" +
                                "- Token Price: " + item.token_price_usd + " (USD)\n" +
                                "- Amount: " + item.amount_usd + " (USD)\n" +
                            "**Entry Time**:\n" + lastTimeStamp + "\n" +
                            "[Token Icon](" + item.token_icon_link + ")",
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: 'Buy on Banana Gun', url: `https://bananagun.com/${item.contract_address}` },
                                        { text: 'Open on Dexscreener', url: `https://dexscreener.com/ethereum/${item.contract_address}` }
                                    ]]
                                }
                            }
                        );
                    }
                } catch (error) {
                    console.error('Error fetching wallet data:', error.message);
                }
            }
        }
    });
}

// Handle button presses for Remove, Edit actions
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    if (data.startsWith('remove_')) {
        const index = parseInt(data.split('_')[1]);
        walletList[chatId].splice(index, 1);
        showWalletList(chatId);
    } else if (data.startsWith('edit_')) {
        const index = parseInt(data.split('_')[1]);
        await bot.sendMessage(chatId, `Please enter the wallet address to update.`);
        userStates[chatId] = { action: 'edit_wallet', index };
    }
});

// Handle wallet input for adding or editing
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const userState = userStates[chatId];
    const walletAddress = msg.text.trim();

    if (text === 'Add Wallet') {
        await bot.sendMessage(chatId, 'Please enter the wallet address to add:');
        userStates[chatId] = { action: 'awaiting_wallet_address' };
        return;
    }
    if (text === 'List Wallets') {
        userStates[chatId] = null;
        showWalletList(chatId);
        return;
    }

    if (userState && userState.action === 'edit_wallet') {
        const index = userState.index;

        // Validate if it's a proper Ethereum address
        if (!ethers.utils.isAddress(walletAddress)) {
            bot.sendMessage(chatId, 'Invalid Ethereum address! Please enter a valid address.');
            return;
        }

        if (walletList[chatId].includes(walletAddress)) {
            await bot.sendMessage(chatId, `The address exists in the list.`);
            userStates[chatId] = null;
            return;
        }
        
        walletList[chatId][index] = walletAddress;
        userStates[chatId] = null;
        showWalletList(chatId);
    } else if (userState && userState.action === 'awaiting_wallet_address') {
        // Validate if it's a proper Ethereum address
        if (!ethers.utils.isAddress(walletAddress)) {
            bot.sendMessage(chatId, 'Invalid Ethereum address! Please enter a valid address.');
            return;
        }

        if(walletList[chatId].includes(walletAddress)) {
            await bot.sendMessage(chatId, `The address exists in the list.`);
            userStates[chatId] = null;
            return;
        }

        walletList[chatId].push(walletAddress);
        userStates[chatId] = null;
        showWalletList(chatId);
    }
});
