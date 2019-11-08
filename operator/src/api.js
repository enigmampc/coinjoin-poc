const {SecretContractClient} = require("./secretContractClient");
const {Store} = require("./store");
const {PUB_KEY_UPDATE, DEAL_CREATED_UPDATE, DEAL_EXECUTED_UPDATE, QUORUM_UPDATE, BLOCK_UPDATE, THRESHOLD_UPDATE, SUBMIT_DEPOSIT_METADATA_RESULT, SUBMIT_DEPOSIT_METADATA_ERROR, FETCH_FILLABLE_SUCCESS, QUORUM_NOT_REACHED_UPDATE, FETCH_CONFIG_SUCCESS} = require("@salad/client").actions;
const Web3 = require('web3');
const {DealManager} = require("./dealManager");
const {utils} = require('enigma-js/node');
const EventEmitter = require('events');
const {CoinjoinClient} = require('@salad/client');
const debug = require('debug')('operator:api');
const EnigmaContract = require('../../build/enigma_contracts/Enigma.json');
const EnigmaTokenContract = require('../../build/enigma_contracts/EnigmaToken.json');

/**
 * @typedef {Object} OperatorAction
 * @property {string} action - The action identified
 * @property {Object} payload - The serialized action payload
 */

// TODO: Consider moving to config
const GET_ENCRYPTION_PUB_KEY_GAS_PRICE = 0.001;
const GET_ENCRYPTION_PUB_KEY_GAS_LIMIT = 4712388;
const EXECUTE_DEAL_GAS_PRICE = 0.001;
const EXECUTE_DEAL_BASE_GAS_UNIT = 3000000;
const EXECUTE_DEAL_PARTICIPANT_GAS_UNIT = 24000000;

class OperatorApi {
    constructor(provider, enigmaUrl, contractAddr, scAddr, threshold, accountIndex = 0, pauseOnRetryInSeconds = 10) {
        this.store = new Store();
        this.web3 = new Web3(provider);
        this.sc = new SecretContractClient(this.web3, scAddr, enigmaUrl, accountIndex);
        this.defaultTaskRecordOpts = {taskGasLimit: 4712388, taskGasPx: 100000000000};
        this.dealManager = new DealManager(this.web3, this.sc, contractAddr, this.store, threshold);
        this.ee = new EventEmitter();
        this.threshold = threshold;
        this.pauseOnRetryInSeconds = pauseOnRetryInSeconds;
        this.active = false;

        // TODO: Default Ethereum options, add to config
        this.txOpts = {
            gas: 100712388,
            gasPrice: process.env.GAS_PRICE,
        };
    }

    /**
     * Initialize the stateful components
     * @returns {Promise<void>}
     */
    async initAsync() {
        await this.store.initAsync();
        await this.sc.initAsync(this.defaultTaskRecordOpts);
        this.active = true;

        process.on('SIGINT', async () => {
            await this.shutdownAsync();
            process.exit();
        });
    }

    async fetchConfigAsync() {
        const scAddr = await this.store.fetchSecretContractAddr();
        const saladAddr = await this.store.fetchSmartContractAddr();
        const networkId = await this.web3.eth.net.getId();
        const enigmaAddr = EnigmaContract.networks[networkId].address;
        const enigmaTokenAddr = EnigmaTokenContract.networks[networkId].address;
        const pubKeyData = await this.loadEncryptionPubKeyAsync();
        const config = {scAddr, saladAddr, enigmaAddr, enigmaTokenAddr, pubKeyData};
        return {action: FETCH_CONFIG_SUCCESS, payload: {config}};
    }

    /**
     * Watch block countdown and trigger deal execution when reached
     * @returns {Promise<void>}
     */
    async watchBlocksUntilDeal() {
        debug('Watching blocks until deal');
        while (this.active === true) {
            const countdown = await this.refreshBlocksUntilDeal();
            debug('Block countdown', countdown);
            if (countdown <= 0) {
                debug('Block countdown <= 0', countdown);
                try {
                    await this.handleDealExecutionAsync();
                } catch (e) {
                    console.error('Fatal execution error', e);
                }
            }
            await utils.sleep(10000);
        }
    }

    /**
     * Refresh block countdown until deal execution event
     * @returns {Promise<number>}
     */
    async refreshBlocksUntilDeal() {
        const blockCountdown = await this.dealManager.getBlocksUntilMixAsync();
        this.ee.emit(BLOCK_UPDATE, blockCountdown);
        return blockCountdown;
    }

    /**
     * Shutdown the server
     * @returns {Promise<void>}
     */
    async shutdownAsync() {
        this.active = false;
        try {
            await this.store.closeAsync();
        } catch (e) {
            console.error('Unable to close the db connection', e);
        }
    }

    /**
     * Call broadcast fn on pub key
     * @param broadcastCallback
     */
    onPubKey(broadcastCallback) {
        this.ee.on(PUB_KEY_UPDATE, (pubKeyData) => {
            broadcastCallback({action: PUB_KEY_UPDATE, payload: {pubKeyData}})
        });
    }

    /**
     * Call broadcast fn on Deal creation
     * @param broadcastCallback
     */
    onDealCreated(broadcastCallback) {
        this.ee.on(DEAL_CREATED_UPDATE, (deal) => {
            broadcastCallback({action: DEAL_CREATED_UPDATE, payload: {deal}})
        });
    }

    /**
     * Call broadcast fn on Deal execution
     * @param broadcastCallback
     */
    onDealExecuted(broadcastCallback) {
        this.ee.on(DEAL_EXECUTED_UPDATE, (deal) => broadcastCallback({action: DEAL_EXECUTED_UPDATE, payload: {deal}}));
    }

    /**
     * Call broadcast fn on Deal execution
     * @param broadcastCallback
     */
    onQuorumNotReached(broadcastCallback) {
        this.ee.on(QUORUM_NOT_REACHED_UPDATE, () => broadcastCallback({
            action: QUORUM_NOT_REACHED_UPDATE,
            payload: {}
        }));
    }

    /**
     * Call broadcast fn on Quorum update
     * @param broadcastCallback
     */
    onQuorumUpdate(broadcastCallback) {
        this.ee.on(QUORUM_UPDATE, (quorum) => broadcastCallback({action: QUORUM_UPDATE, payload: {quorum}}));
    }

    onBlock(broadcastCallback) {
        this.ee.on(BLOCK_UPDATE, (blockCountdown) => broadcastCallback({
            action: BLOCK_UPDATE,
            payload: {blockCountdown}
        }));
    }

    /**
     * Return the threshold value
     * @returns {OperatorAction}
     */
    getThreshold() {
        const threshold = this.threshold;
        return {action: THRESHOLD_UPDATE, payload: {threshold}};
    }

    /**
     * Post-processing after each deposit.
     * Creates a deal if the quorum is reached.
     * @returns {Promise<void>}
     */
    async handleDealExecutionAsync() {
        debug('Evaluating deal creation in non-blocking scope');
        const deposits = await this.dealManager.balanceFillableDepositsAsync();
        const taskRecordOpts = {
            taskGasLimit: EXECUTE_DEAL_BASE_GAS_UNIT + (deposits.length * EXECUTE_DEAL_PARTICIPANT_GAS_UNIT),
            taskGasPx: utils.toGrains(EXECUTE_DEAL_GAS_PRICE),
        };
        // TODO: Account for empty deposits
        /** @type string */
        const depositAmount = deposits[0].amount;
        if (deposits.length >= this.threshold) {
            debug('Quorum reached with deposits', deposits);
            await this.dealManager.updateLastMixBlockNumberAsync();

            let deal;
            try {
                deal = await this.dealManager.createDealAsync(depositAmount, deposits, this.txOpts);
                debug('Broadcasting new deal');
                this.ee.emit(DEAL_CREATED_UPDATE, deal);
                debug('Broadcasting quorum value 0 after new deal');
                this.ee.emit(QUORUM_UPDATE, 0);
            } catch (e) {
                // TODO: Retry
                console.error('Deal creation error', e);
                debug('Broadcasting quorum value 0 after new deal');
                this.ee.emit(QUORUM_UPDATE, 0);
                // throw new Error('Unable to create deal');
            }

            try {
                // Resetting quorum
                this.ee.emit(QUORUM_UPDATE, 0);
                debug('Deal created on Ethereum, executing...', deal._tx);
                await this.dealManager.executeDealAsync(deal, taskRecordOpts);
                debug('Deal executed on Ethereum', deal._tx);
                this.ee.emit(DEAL_EXECUTED_UPDATE, deal);
            } catch (e) {
                // TODO: Retry here, create new execution task when the epoch changes
                console.error('Deal execution error', e);
                // throw new Error('Unable to execute deal');
            }
        } else {
            debug('Quorum not reached skipping deal execution');
            try {
                await this.dealManager.verifyDepositsAsync(depositAmount, deposits, taskRecordOpts);
                this.ee.emit(QUORUM_NOT_REACHED_UPDATE, null);
            } catch (e) {
                // TODO: Retry here, create new execution task when the epoch changes
                console.error('Unable to verify deposits', e);
            }
        }
    }

    /**
     * Fetch the encryption public key and store it in cache
     * @returns {Promise<OperatorAction>}
     */
    async loadEncryptionPubKeyAsync() {
        debug('Sending encryption public key to new connected client');
        const taskRecordOpts = {
            taskGasLimit: GET_ENCRYPTION_PUB_KEY_GAS_LIMIT,
            taskGasPx: utils.toGrains(GET_ENCRYPTION_PUB_KEY_GAS_PRICE),
        };
        /** @type EncryptionPubKey|null */
        let pubKeyData = await this.store.fetchPubKeyData();
        debug('Pub key data from cache', pubKeyData);
        while (pubKeyData === null) {
            try {
                await utils.sleep(300);
                debug('This is the first start, fetching the encryption key from Enigma');
                pubKeyData = await this.sc.getPubKeyDataAsync(taskRecordOpts);
                if (pubKeyData !== null) {
                    await this.store.insertPubKeyDataInCache(pubKeyData);
                }
            } catch (e) {
                console.error('Unable to fetch public encryption key', e);
                // TODO: Consider cancelling and creating new task when the epoch changes
                await utils.sleep(this.pauseOnRetryInSeconds * 1000);
            }
        }
        // this.ee.emit(PUB_KEY_UPDATE, pubKeyData);
        return pubKeyData;
    }

    /**
     * Verify the deposit signature
     * @param {DepositPayload} payload
     * @param {string} signature
     * @returns {*}
     * @private
     */
    _verifyDepositSignature(payload, signature) {
        const messageBytes = CoinjoinClient.buildDepositMessage(this.web3, payload);
        const message = this.web3.utils.bytesToHex(messageBytes);
        debug('Verifying message', message, 'with signature', signature);
        const hash = this.web3.utils.soliditySha3({t: 'bytes', v: message});
        const sender = this.web3.eth.accounts.recover(hash, signature);
        debug('Recovered sender', sender);
        return (sender === payload.sender);
    }

    /**
     * Coordinate the submission of a new deposit
     * @param sender
     * @param amount
     * @param pubKey
     * @param encRecipient
     * @param signature
     * @returns {Promise<OperatorAction>}
     */
    async submitDepositMetadataAsync(sender, amount, pubKey, encRecipient, signature) {
        debug('In submitDepositMetadataAsync(', sender, amount, pubKey, encRecipient, signature, ')');
        const payload = {sender, amount, encRecipient, pubKey};
        // TODO: Disabled temporarily while troubleshoot metamask signature issue
        if (!this._verifyDepositSignature(payload, signature)) {
            debug(`Signature verification failed: ${signature}`);
            return {action: SUBMIT_DEPOSIT_METADATA_RESULT, payload: {err: 'Invalid signature'}};
        }
        const registeredDeposit = await this.dealManager.registerDepositAsync(sender, amount, pubKey, encRecipient, signature);
        debug('Registered deposit', registeredDeposit);

        const fillableDeposits = await this.dealManager.fetchFillableDepositsAsync();
        const quorum = fillableDeposits.length;

        debug('Broadcasting quorum update', quorum);
        this.ee.emit(QUORUM_UPDATE, quorum);

        return {action: SUBMIT_DEPOSIT_METADATA_RESULT, payload: true};
    }

    /**
     * Return a list of fillable deposits
     * @returns {Promise<OperatorAction>}
     */
    async fetchFillableDepositsAsync(minimumAmount) {
        const deposits = await this.dealManager.fetchFillableDepositsAsync(minimumAmount);
        return {action: FETCH_FILLABLE_SUCCESS, payload: {deposits}};
    }

    /**
     * Return the current Quorum value
     * @returns {Promise<OperatorAction>}
     */
    async fetchQuorumAsync(minimumAmount) {
        // Sending current quorum on connection
        const fillableDeposits = await this.dealManager.fetchFillableDepositsAsync(minimumAmount);
        const quorum = fillableDeposits.length;
        return {action: QUORUM_UPDATE, payload: {quorum}};
    }
}

module.exports = {OperatorApi};