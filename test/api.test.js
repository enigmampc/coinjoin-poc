require('dotenv').config();
const fs = require('fs');
const {CoinjoinClient} = require('@salad/client');
const {startServer} = require('@salad/operator');
const {expect} = require('chai');
const SaladContract = artifacts.require('Salad');
const {utils} = require('enigma-js/node');
const debug = require('debug')('test');

const EnigmaTokenContract = require('../build/enigma_contracts/EnigmaToken.json');
const EnigmaContract = require('../build/enigma_contracts/Enigma.json');
// const EnigmaContract = artifacts.require('Enigma');
const {DEALS_COLLECTION, DEPOSITS_COLLECTION, CACHE_COLLECTION} = require('@salad/operator/src/store');

contract('Salad', () => {
    let server;
    let salad;
    let opts;
    let token;
    let web3Utils;
    let accounts;
    before(async () => {
        const operatorAccountIndex = 0;
        const provider = web3._provider;
        const scAddr = fs.readFileSync(`${__dirname}/salad.txt`, 'utf-8');
        const threshold = 2;
        const saladContractAddr = SaladContract.address;
        const enigmaContractAddr = EnigmaContract.networks[process.env.ETH_NETWORK_ID].address;
        const enigmaUrl = `http://${process.env.ENIGMA_HOST}:${process.env.ENIGMA_PORT}`;
        server = await startServer(provider, enigmaUrl, saladContractAddr, scAddr, threshold, operatorAccountIndex);

        // Truncating the database
        await server.store.truncate(DEPOSITS_COLLECTION);
        await server.store.truncate(DEALS_COLLECTION);
        await server.store.truncate(CACHE_COLLECTION);

        const operatorUrl = `ws://localhost:${process.env.WS_PORT}`;
        salad = new CoinjoinClient(saladContractAddr, enigmaContractAddr, operatorUrl, provider);
        // Always shutdown the WS server when tests end
        process.on('SIGINT', async () => {
            debug('Caught interrupt signal, shutting down WS server');
            await salad.shutdownAsync();
            await server.shutdownAsync();
            process.exit();
        });
        await salad.initAsync();
        // Convenience shortcuts
        web3Utils = web3.utils;
        accounts = salad.accounts;
        // Default options of client-side transactions
        opts = {
            gas: 4712388,
            gasPrice: 100000000000,
        };
        const tokenAddr = EnigmaTokenContract.networks[process.env.ETH_NETWORK_ID].address;
        token = new web3.eth.Contract(EnigmaTokenContract['abi'], tokenAddr);
    });

    it('should connect to the WS server', async () => {
        debug('Testing connection');
        const action = new Promise((resolve) => {
            salad.ws.once('message', (msg) => {
                const {action} = JSON.parse(msg);
                if (action === 'pong') {
                    resolve(action);
                }
            });
        });
        salad.ws.send(JSON.stringify({action: 'ping', payload: {}}));
        await action;
    });

    let pubKey;
    it('should fetch and cache the encryption pub key', async () => {
        await server.loadEncryptionPubKeyAsync();
        await utils.sleep(300);
        expect(salad.pubKeyData).to.not.be.null;
        expect(salad.keyPair).to.not.be.null;
        pubKey = salad.keyPair.publicKey;
    }).timeout(60000); // Giving more time because fetching the pubKey

    let amount;
    it('should have a valid block countdown', async () => {
        await server.refreshBlocksUntilDeal();
        await utils.sleep(300);
        debug('The block countdown', salad.blockCountdown);
        expect(salad.blockCountdown).to.be.above(0);
        amount = web3Utils.toWei('10');
    });

    const quorumReached = new Promise((resolve) => {
        const nbDeposits = parseInt(process.env.PARTICIPATION_THRESHOLD);
        let sender;
        let encRecipient;
        let signature;
        for (let i = 0; i < nbDeposits; i++) {
            const depositIndex = i + 1;
            it(`should make deposit ${depositIndex} on Ethereum`, async () => {
                sender = salad.accounts[depositIndex];
                const receipt = await salad.makeDepositAsync(sender, amount, opts);
                expect(receipt.status).to.equal(true);
            });

            it(`should encrypt deposit ${depositIndex}`, async () => {
                const recipient = salad.accounts[depositIndex + 1];
                encRecipient = await salad.encryptRecipientAsync(recipient);
            });

            it(`should sign deposit ${depositIndex} payload`, async () => {
                signature = await salad.signDepositMetadataAsync(sender, amount, encRecipient, pubKey);
                debug('The signature', signature);
                const sigBytes = web3Utils.hexToBytes(signature);
                debug('The signature length', sigBytes.length, sigBytes);
                expect(sigBytes.length).to.equal(65);
            });

            it(`should submit signed deposit ${depositIndex} payload`, async () => {
                debug('Testing deposit submit with signature', signature);
                const result = await salad.submitDepositMetadataAsync(sender, amount, encRecipient, pubKey, signature);
                expect(result).to.equal(true);
            }).timeout(5000);
        }

        it('should verify that the submitted deposits are fillable', async () => {
            // Quorum should be N after deposits
            expect(salad.quorum).to.equal(nbDeposits);
            const {deposits} = await salad.fetchFillableDepositsAsync();
            expect(deposits.length).to.equal(nbDeposits);
            resolve(true);
        }).timeout(5000);
    });

    let dealPromise;
    let executedDealPromise;
    it('should mine blocks until the deal interval', async () => {
        await quorumReached;
        let countdown;
        do {
            const result = await new Promise((resolve, reject) => {
                web3.currentProvider.send({
                    jsonrpc: '2.0',
                    method: 'evm_mine',
                    id: new Date().getTime()
                }, (err, result) => {
                    if (err) {
                        return reject(err)
                    }
                    return resolve(result)
                });
            });
            debug('Mined block', result);
            countdown = await server.refreshBlocksUntilDeal();
        } while (countdown > 0);
        // Catching the deal created event
        dealPromise = new Promise((resolve) => {
            salad.onDealCreated((deal) => resolve(deal));
        });
        executedDealPromise = new Promise((resolve) => {
            salad.onDealExecuted((deal) => resolve(deal));
        });
        await server.handleDealExecutionAsync();
    }).timeout(120000); // Give enough time to execute the deal on Enigma

    it('should verify that a deal was created since the threshold is reached', async () => {
        const deal = await dealPromise;
        debug('Created deal', deal);
        const deals = await salad.findDealsAsync(1);
        expect(deals.length).to.equal(1);
        // Quorum should be reset to 0 after deal creation
        expect(salad.quorum).to.equal(0);
    });

    it('should verify the deal execution', async () => {
        const deal = await executedDealPromise;
        debug('Executed deal', deal);
        const deals = await salad.findDealsAsync(2);
        // expect(deals.length).to.equal(1);
        // Quorum should be reset to 0 after deal creation
        expect(salad.quorum).to.equal(0);
    });
});
