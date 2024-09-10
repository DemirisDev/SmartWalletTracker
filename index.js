require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

// Initialize the bot and provider
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const provider = new ethers.providers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);

Moralis.start({ apiKey: process.env.MORALIS_API_KEY });

let walletList = {};
let userStates = {};

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
            { text: 'Edit', callback_data: `edit_${index}` },
            { text: 'Remove', callback_data: `remove_${index}` }
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
    // Listen for new blocks
    provider.on('block', async (blockNumber) => {
        console.log(typeof blockNumber)
        const lastBlock = blockNumber - 1;
        const block = await provider.getBlockWithTransactions(lastBlock);

        console.log(lastBlock)

        const fromAddresses = new Set(block.transactions
            .map(tx => tx.from.toLowerCase())
        );

        for (const wallet of walletList[chatId].filter(fwallet => fromAddresses.has(fwallet.toLowerCase()))) {
            console.log(wallet)
            try {
                const txHistory = await Moralis.EvmApi.wallets.getWalletHistory({
                    address: wallet,
                    chain: EvmChain.ETHEREUM,
                    fromBlock: lastBlock,
                    toBlock: lastBlock
                });
                console.log(txHistory.result)
                const swapHistory = txHistory.result.filter(h => h.category === 'token swap');
                console.log(swapHistory)

                for (const swap of swapHistory) {
                    for (const item of swap.erc20Transfers) {
                        console.log(item)
                        const tokenAddress = item.address.lowercase;
                        const tokenName = item.tokenName;
                        const tokenSymbol = item.tokenSymbol;
                        const swapType = item.fromAddress.equals(wallet) ? 'Sell' : 'Buy';
                        const amount = item.valueFormatted;
                        await bot.sendMessage(
                            chatId,
                            "New Transaction - " + swapType + "!\n" +
                            "Wallet:\n`" + wallet + "`\n" +
                            "Token Address:\n`" + tokenAddress + "`\n" +
                            "Token Name: " + tokenName + "\n" +
                            "Token Symbol: " + tokenSymbol + "\n" +
                            "Amount: " + amount + "\n" +
                            "Entry Time: " + swap.blockTimestamp + "\n",
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: 'Buy on Banana Gun', url: `https://t.me/BananaGunSniper_bot` },
                                        { text: 'Open on Dexscreener', url: `https://dexscreener.com/ethereum/${tokenAddress}` }
                                    ]]
                                }
                            }
                        );
                    }
                }
            } catch (error) {
                console.error(error);
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

        if (walletList[chatId].includes(walletAddress)) {
            await bot.sendMessage(chatId, `The address exists in the list.`);
            userStates[chatId] = null;
            return;
        }

        walletList[chatId].push(walletAddress);
        userStates[chatId] = null;
        showWalletList(chatId);
    }
});
