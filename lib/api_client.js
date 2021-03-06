/* globals window */
var _ = require('lodash'),
    q = require('q'),
    bitcoin = require('bitcoinjs-lib'),
    bip39 = require("bip39"),
    Wallet = require('./wallet'),
    RestClient = require('./rest_client'),
    blocktrail = require('./blocktrail');

var workify = require('webworkify');

var isNodeJS = !process.browser;
var useWebWorker = !isNodeJS && typeof window !== "undefined" && typeof window.Worker !== "undefined";


/**
 * Bindings to consume the BlockTrail API
 *
 * @param options       object{
 *                          apiKey: 'API_KEY',
 *                          apiSecret: 'API_SECRET',
 *                          host: 'defaults to api.blocktrail.com',
 *                          network: 'BTC|LTC',
 *                          testnet: true|false
 *                      }
 * @constructor
 */
var APIClient = function(options) {
    var self = this;

    // handle constructor call without 'new'
    if (!(this instanceof APIClient)) {
        return new APIClient(options);
    }

    // BLOCKTRAIL_SDK_API_ENDPOINT overwrite for development
    if (process.env.BLOCKTRAIL_SDK_API_ENDPOINT) {
        options.host = process.env.BLOCKTRAIL_SDK_API_ENDPOINT;
    }

    // trim off leading https?://
    if (options.host && options.host.indexOf("https://") === 0) {
        options.https = true;
        options.host = options.host.substr(8);
    } else if (options.host && options.host.indexOf("http://") === 0) {
        options.https = false;
        options.host = options.host.substr(7);
    }

    if (typeof options.https === "undefined") {
        options.https = true;
    }

    if (!options.host) {
        options.host = 'api.blocktrail.com';
    }

    if (!options.port) {
        options.port = options.https ? 443 : 80;
    }

    self.testnet = options.testnet = options.testnet || false;
    if (self.testnet) {
        self.network = bitcoin.networks.testnet;
    } else {
        self.network = bitcoin.networks.bitcoin;
    }

    if (!options.endpoint) {
        options.endpoint = "/" + (options.apiVersion || "v1") + "/" + (self.testnet ? "t" : "") + (options.network || 'BTC').toUpperCase();
    }

    /**
     * @type RestClient
     */
    self.client = new RestClient(options);
};

APIClient.prototype.mnemonicToPrivateKey = function(mnemonic, passphrase, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    var network = self.testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

    if (useWebWorker) {
        var worker = workify(require('./webworker'));

        worker.addEventListener('message', function(e) {
            deferred.resolve(bitcoin.HDNode.fromSeedHex(e.data.seed, network));
        }, false);

        worker.addEventListener('error', function(e) {
            deferred.reject(new blocktrail.Error(e.message.replace("Uncaught Error: ", '')));
        });

        worker.postMessage({method: 'mnemonicToSeedHex', mnemonic: mnemonic, passphrase: passphrase});
    } else {
        deferred.resolve(bitcoin.HDNode.fromSeedBuffer(bip39.mnemonicToSeed(mnemonic, passphrase), network));
    }

    return deferred.promise;
};

APIClient.prototype.resolvePrimaryPrivateKeyFromOptions = function(options, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    var network = self.testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

    try {
        var passphrase = options.passphrase || options.password;
        var primaryMnemonic = options.primaryMnemonic;
        var primaryPrivateKey = options.primaryPrivateKey;

        if (primaryMnemonic && primaryPrivateKey) {
            throw new blocktrail.WalletInitError("Can't specify Primary Mnemonic and Primary PrivateKey");
        }

        if (!primaryMnemonic && !primaryPrivateKey) {
            throw new blocktrail.WalletInitError("Can't init wallet without Primary Mnemonic or Primary PrivateKey");
        }

        if (primaryMnemonic && !passphrase) {
            throw new blocktrail.WalletInitError("Can't init wallet with Primary Mnemonic without a passphrase");
        }

        if (primaryPrivateKey && !(primaryPrivateKey instanceof bitcoin.HDNode)) {
            primaryPrivateKey = bitcoin.HDNode.fromBase58(primaryPrivateKey, network);
        }

        if (primaryPrivateKey) {
            deferred.resolve([primaryMnemonic, primaryPrivateKey]);
        } else {
            deferred.resolve(self.mnemonicToPrivateKey(primaryMnemonic, passphrase).then(function(primaryPrivateKey) {
                return [primaryMnemonic, primaryPrivateKey];
            }));
        }
    } catch (e) {
        deferred.reject(e);
    }

    return deferred.promise;
};

APIClient.prototype.resolveBackupPublicKeyFromOptions = function(options, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    var network = self.testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

    try {
        var backupMnemonic = options.backupMnemonic;
        var backupPublicKey = options.backupPublicKey;

        if (backupMnemonic && backupPublicKey) {
            throw new blocktrail.WalletInitError("Can't specify Backup Mnemonic and Backup PrivateKey");
        }

        if (!backupMnemonic && !backupPublicKey) {
            backupMnemonic = bip39.generateMnemonic(512);
        }

        if (backupPublicKey && !(backupPublicKey instanceof bitcoin.HDNode)) {
            backupPublicKey = bitcoin.HDNode.fromBase58(backupPublicKey, network);
        }

        if (backupPublicKey) {
            deferred.resolve([null, backupPublicKey]);
        } else {
            deferred.resolve(self.mnemonicToPrivateKey(backupMnemonic, "").then(function(backupPrivateKey) {
                backupPublicKey = backupPrivateKey.neutered();
                return [backupMnemonic, backupPublicKey];
            }));
        }
    } catch (e) {
        deferred.reject(e);
    }

    return deferred.promise;
};


APIClient.prototype.debugAuth = function(cb) {
    var self = this;

    return self.client.get("/debug/http-signature", null, true, cb);
};

/**
 * get a single address
 *
 * @param address      string       address hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.address = function(address, cb) {
    var self = this;

    return self.client.get("/address/" + address, null, cb);
};

APIClient.prototype.addresses = function(addresses, cb) {
    var self = this;

    return self.client.post("/address", null, {"addresses": addresses}, cb);
};

/**
 * get all transactions for an address (paginated)
 *
 * @param address       string      address hash
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.addressTransactions = function(address, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/address/" + address + "/transactions", params, cb);
};

/**
 * get all unconfirmed transactions for an address (paginated)
 *
 * @param address       string      address hash
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.addressUnconfirmedTransactions = function(address, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/address/" + address + "/unconfirmed-transactions", params, cb);
};

/**
 * get all inspent outputs for an address (paginated)
 *
 * @param address       string      address hash
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.addressUnspentOutputs = function(address, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/address/" + address + "/unspent-outputs", params, cb);
};

/**
 * verify ownership of an address
 *
 * @param address       string      address hash
 * @param signature     string      a signed message (the address hash) using the private key of the address
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.verifyAddress = function(address, signature, cb) {
    var self = this;

    return self.client.post("/address/" + address + "/verify", null, {signature: signature}, cb);
};

/**
 * get all blocks (paginated)
 *
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.allBlocks = function(params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/all-blocks", params, cb);
};

/**
 * get a block
 *
 * @param block         string|int  a block hash or a block height
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.block = function(block, cb) {
    var self = this;

    return self.client.get("/block/" + block, null, cb);
};

/**
 * get the latest block
 *
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.blockLatest = function(cb) {
    var self = this;

    return self.client.get("/block/latest", null, cb);
};

/**
 * get all transactions for a block (paginated)
 *
 * @param block         string|int  a block hash or a block height
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.blockTransactions = function(block, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/block/" + block + "/transactions", params, cb);
};

/**
 * get a single transaction
 *
 * @param tx            string      transaction hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.transaction = function(tx, cb) {
    var self = this;

    return self.client.get("/transaction/" + tx, null, cb);
};

/**
 * get a batch of transactions
 *
 * @param txs           string[]    list of transaction hashes (txId)
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.transactions = function(txs, cb) {
    var self = this;

    return self.client.post("/transactions", null, txs, cb, false);
};

/**
 * get a paginated list of all webhooks associated with the api user
 *
 * @param [params]      object      pagination: {page: 1, limit: 20}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.allWebhooks = function(params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/webhooks", params, cb);
};

/**
 * create a new webhook
 *
 * @param url           string      the url to receive the webhook events
 * @param [identifier]  string      a unique identifier associated with the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.setupWebhook = function(url, identifier, cb) {
    var self = this;

    if (typeof identifier === "function" && typeof cb === "undefined") {
        //mimic function overloading
        cb = identifier;
        identifier = null;
    }

    return self.client.post("/webhook", null, {url: url, identifier: identifier}, cb);
};

/**
 * get an existing webhook by it's identifier
 *
 * @param identifier    string      the unique identifier of the webhook to get
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.getWebhook = function(identifier, cb) {
    var self = this;

    return self.client.get("/webhook/" + identifier, null, cb);
};

/**
 * update an existing webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param webhookData   object      the data to update: {identifier: newIdentifier, url:newUrl}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.updateWebhook = function(identifier, webhookData, cb) {
    var self = this;

    return self.client.put("/webhook/" + identifier, null, webhookData, cb);
};

/**
 * deletes an existing webhook and any event subscriptions associated with it
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.deleteWebhook = function(identifier, cb) {
    var self = this;

    return self.client.delete("/webhook/" + identifier, null, null, cb);
};

/**
 * get a paginated list of all the events a webhook is subscribed to
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [params]      object      pagination: {page: 1, limit: 20}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.getWebhookEvents = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/webhook/" + identifier + "/events", params, cb);
};

/**
 * subscribes a webhook to transaction events for a particular transaction
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param transaction   string      the transaction hash
 * @param confirmations integer     the amount of confirmations to send
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.subscribeTransaction = function(identifier, transaction, confirmations, cb) {
    var self = this;
    var postData = {
        'event_type': 'transaction',
        'transaction': transaction,
        'confirmations': confirmations
    };

    return self.client.post("/webhook/" + identifier + "/events", null, postData, cb);
};

/**
 * subscribes a webhook to transaction events on a particular address
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param address       string      the address hash
 * @param confirmations integer     the amount of confirmations to send
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.subscribeAddressTransactions = function(identifier, address, confirmations, cb) {
    var self = this;
    var postData = {
        'event_type': 'address-transactions',
        'address': address,
        'confirmations': confirmations
    };

    return self.client.post("/webhook/" + identifier + "/events", null, postData, cb);
};

/**
 * batch subscribes a webhook to multiple transaction events
 *
 * @param  identifier   string      the unique identifier of the webhook
 * @param  batchData    array       An array of objects containing batch event data:
 *                                  {address : 'address', confirmations : 'confirmations']
 *                                  where address is the address to subscribe to and confirmations (optional) is the amount of confirmations to send
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.batchSubscribeAddressTransactions = function(identifier, batchData, cb) {
    var self = this;
    batchData.forEach(function(record) {
        record.event_type = 'address-transactions';
    });

    return self.client.post("/webhook/" + identifier + "/events/batch", null, batchData, cb);
};

/**
 * subscribes a webhook to a new block event
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.subscribeNewBlocks = function(identifier, cb) {
    var self = this;
    var postData = {
        'event_type': 'block'
    };

    return self.client.post("/webhook/" + identifier + "/events", null, postData, cb);
};

/**
 * removes an address transaction event subscription from a webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param address       string      the address hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.unsubscribeAddressTransactions = function(identifier, address, cb) {
    var self = this;

    return self.client.delete("/webhook/" + identifier + "/address-transactions/" + address, null, null, cb);
};

/**
 * removes an transaction event subscription from a webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param transaction   string      the transaction hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.unsubscribeTransaction = function(identifier, transaction, cb) {
    var self = this;

    return self.client.delete("/webhook/" + identifier + "/transaction/" + transaction, null, null, cb);
};

/**
 * removes a block event subscription from a webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.unsubscribeNewBlocks = function(identifier, cb) {
    var self = this;

    return self.client.delete("/webhook/" + identifier + "/block", null, null, cb);
};

/**
 * initialize an existing wallet
 *
 * Either takes two argument:
 * @param options       object      {}
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * Or takes three arguments (old, deprecated syntax):
 * @param identifier    string      the wallet identifier to be initialized
 * @param passphrase    string      the password to decrypt the mnemonic with
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * @returns {q.Promise}
 */
APIClient.prototype.initWallet = function(options, cb) {
    var self = this;

    if (typeof options !== "object") {
        // get the old-style arguments
        options = {
            identifier: arguments[0],
            passphrase: arguments[1]
        };

        cb = arguments[2];
    }

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    var network = self.testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

    var identifier = options.identifier;

    if (!identifier) {
        deferred.reject(new blocktrail.WalletInitError("Identifier is required"));
        return deferred.promise;
    }

    deferred.resolve(self.client.get("/wallet/" + identifier, null, true).then(function(result) {
        var keyIndex = options.keyIndex || result.key_index;
        var readOnly = options.readOnly;

        var backupPublicKey = bitcoin.HDNode.fromBase58(result.backup_public_key[0], network);
        var blocktrailPublicKeys = _.mapValues(result.blocktrail_public_keys, function(blocktrailPublicKey) {
            return bitcoin.HDNode.fromBase58(blocktrailPublicKey[0], self.network);
        });
        var primaryPublicKeys = _.mapValues(result.primary_public_keys, function(primaryPublicKey) {
            return bitcoin.HDNode.fromBase58(primaryPublicKey[0], self.network);
        });

        // initialize wallet
        var wallet = new Wallet(
            self,
            identifier,
            result.primary_mnemonic,
            primaryPublicKeys,
            backupPublicKey,
            blocktrailPublicKeys,
            keyIndex,
            self.testnet,
            result.checksum,
            result.upgrade_key_index,
            options.bypassNewAddressCheck
        );

        if (!readOnly) {
            return wallet.unlock(options).then(function() {
                return wallet;
            });
        } else {
            return wallet;
        }
    }));

    return deferred.promise;
};
/**
 * create a new wallet
 *   - will generate a new primary seed (with password) and backup seed (without password)
 *   - send the primary seed (BIP39 'encrypted') and backup public key to the server
 *   - receive the blocktrail co-signing public key from the server
 *
 * Either takes two argument:
 * @param options       object      {}
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * Or takes four arguments (old, deprecated syntax):
 * @param identifier    string      the wallet identifier to be initialized
 * @param passphrase    string      the password to decrypt the mnemonic with
 * @param keyIndex      int         override for the blocktrail cosign key to use (for development purposes)
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 * @returns {q.Promise}
 */
APIClient.prototype.createNewWallet = function(options, cb) {
    /* jshint -W071, -W074 */

    var self = this;

    if (typeof options !== "object") {
        // get the old-style arguments
        var identifier = arguments[0];
        var passphrase = arguments[1];
        var keyIndex = arguments[2];
        cb = arguments[3];

        // keyIndex is optional
        if (typeof keyIndex === "function") {
            cb = keyIndex;
            keyIndex = null;
        }

        options = {
            identifier: identifier,
            passphrase: passphrase,
            keyIndex: keyIndex
        };
    }

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    options.keyIndex = options.keyIndex || 0;
    options.passphrase = options.passphrase || options.password;

    if (!options.identifier) {
        deferred.reject(new blocktrail.WalletCreateError("Identifier is required"));
        return deferred.promise;
    }

    if (!options.primaryMnemonic && !options.primaryPrivateKey) {
        if (!options.passphrase) {
            deferred.reject(new blocktrail.WalletCreateError("Can't generate Primary Mnemonic without a passphrase"));
            return deferred.promise;
        } else {
            options.primaryMnemonic = bip39.generateMnemonic(512);
            if (options.storePrimaryMnemonic !== false) {
                options.storePrimaryMnemonic = true;
            }
        }
    }

    if (!options.backupMnemonic && !options.backupPublicKey) {
        options.backupMnemonic = bip39.generateMnemonic(512);
    }

    // @TODO: we can async this
    deferred.resolve(self.resolvePrimaryPrivateKeyFromOptions(options).spread(
        function(primaryMnemonic, primaryPrivateKey) {

            return self.resolveBackupPublicKeyFromOptions(options).spread(
                function(backupMnemonic, backupPublicKey) {
                    // create a checksum of our private key which we'll later use to verify we used the right password
                    var checksum = primaryPrivateKey.getAddress().toBase58Check();
                    var keyIndex = options.keyIndex;

                    var primaryPublicKey = primaryPrivateKey.deriveHardened(keyIndex).neutered();

                    // send the public keys to the server to store them
                    //  and the mnemonic, which is safe because it's useless without the password
                    return self._createNewWallet(
                        options.identifier,
                        [primaryPublicKey.toBase58(), "M/" + keyIndex + "'"],
                        [backupPublicKey.toBase58(), "M"],
                        primaryMnemonic || false,
                        checksum,
                        keyIndex
                    )
                    .then(
                        function(result) {
                            var blocktrailPublicKeys = _.mapValues(result.blocktrail_public_keys, function(blocktrailPublicKey) {
                                return bitcoin.HDNode.fromBase58(blocktrailPublicKey[0], self.network);
                            });

                            var wallet = new Wallet(
                                self,
                                options.identifier,
                                options.storePrimaryMnemonic ? primaryMnemonic : null,
                                {keyIndex: primaryPublicKey},
                                backupPublicKey,
                                blocktrailPublicKeys,
                                keyIndex,
                                self.testnet,
                                checksum,
                                result.upgrade_key_index,
                                options.bypassNewAddressCheck
                            );

                            // pass along primaryPrivateKey to avoid another bip39 mnemonic -> seed
                            return wallet.unlock({primaryPrivateKey: primaryPrivateKey, primaryMnemonic: null}).then(function() {
                                return [wallet, primaryMnemonic, backupMnemonic, blocktrailPublicKeys];
                            });
                        }
                    );
                }
            );
        }
    ));

    return deferred.promise;
};

/**
 * create wallet using the API
 *
 * @param identifier            string      the wallet identifier to create
 * @param primaryPublicKey      array       the primary public key - [key, path] should be M/<keyIndex>'
 * @param backupPublicKey       array       the backup public key - [key, path] should be M/<keyIndex>'
 * @param primaryMnemonic       string      mnemonic to store
 * @param checksum              string      checksum to store
 * @param keyIndex              int         keyIndex that was used to create wallet
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype._createNewWallet = function(identifier, primaryPublicKey, backupPublicKey, primaryMnemonic, checksum, keyIndex, cb) {
    var self = this;

    var postData = {
        identifier: identifier,
        primary_public_key: primaryPublicKey,
        backup_public_key: backupPublicKey,
        primary_mnemonic: primaryMnemonic,
        checksum: checksum,
        key_index: keyIndex
    };

    return self.client.post("/wallet", null, postData, cb);
};

/**
 * upgrade wallet to use a new account number
 *  the account number specifies which blocktrail cosigning key is used
 *
 * @param identifier            string      the wallet identifier
 * @param primaryPublicKey      array       the primary public key - [key, path] should be M/<keyIndex>'
 * @param keyIndex              int         keyIndex that was used to create wallet
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.upgradeKeyIndex = function(identifier, keyIndex, primaryPublicKey, cb) {
    var self = this;

    return self.client.post("/wallet/" + identifier + "/upgrade", null, {
        key_index: keyIndex,
        primary_public_key: primaryPublicKey
    }, cb);
};

/**
 * get the balance for the wallet
 *
 * @param identifier            string      the wallet identifier
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.getWalletBalance = function(identifier, cb) {
    var self = this;

    return self.client.get("/wallet/" + identifier + "/balance", null, true, cb);
};

/**
 * do HD wallet discovery for the wallet
 *
 * @param identifier            string      the wallet identifier
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.doWalletDiscovery = function(identifier, gap, cb) {
    var self = this;

    return self.client.get("/wallet/" + identifier + "/discovery", {gap: gap}, true, cb);
};


/**
 * get a new derivation number for specified parent path
 *  eg; m/44'/1'/0/0 results in m/44'/1'/0/0/0 and next time in m/44'/1'/0/0/1 and next time in m/44'/1'/0/0/2
 *
 * @param identifier            string      the wallet identifier
 * @param path                  string      the parent path for which to get a new derivation,
 *                                           can be suffixed with /* to make it clear on which level the derivations hould be
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.getNewDerivation = function(identifier, path, cb) {
    var self = this;

    return self.client.post("/wallet/" + identifier + "/path", null, {path: path}, cb);
};


/**
 * delete the wallet
 *  the checksum address and a signature to verify you ownership of the key of that checksum address
 *  is required to be able to delete a wallet
 *
 * @param identifier            string      the wallet identifier
 * @param checksumAddress       string      the address for your master private key (and the checksum used when creating the wallet)
 * @param checksumSignature     string      a signature of the checksum address as message signed by the private key matching that address
 * @param [force]               bool        ignore warnings (such as a non-zero balance)
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.deleteWallet = function(identifier, checksumAddress, checksumSignature, force, cb) {
    var self = this;

    if (typeof force === "function") {
        cb = force;
        force = false;
    }

    return self.client.delete("/wallet/" + identifier, {force: force}, {
        checksum: checksumAddress,
        signature: checksumSignature
    }, cb);
};

/**
 * use the API to get the best inputs to use based on the outputs
 *
 * the return array has the following format:
 * [
 *  "utxos" => [
 *      [
 *          "hash" => "<txHash>",
 *          "idx" => "<index of the output of that <txHash>",
 *          "scriptpubkey_hex" => "<scriptPubKey-hex>",
 *          "value" => 32746327,
 *          "address" => "1address",
 *          "path" => "m/44'/1'/0'/0/13",
 *          "redeem_script" => "<redeemScript-hex>",
 *      ],
 *  ],
 *  "fee"   => 10000,
 *  "change"=> 1010109201,
 * ]
 *
 * @param identifier        string      the wallet identifier
 * @param pay               array       {'address': (int)value}     coins to send
 * @param lockUTXO          bool        lock UTXOs for a few seconds to allow for transaction to be created
 * @param allowZeroConf     bool        allow zero confirmation unspent outputs to be used in coin selection
 * @param [cb]              function    callback(err, utxos, fee, change)
 * @returns {q.Promise}
 */
APIClient.prototype.coinSelection = function(identifier, pay, lockUTXO, allowZeroConf, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    deferred.resolve(
        self.client.post("/wallet/" + identifier + "/coin-selection", {lock: lockUTXO, zeroconf: allowZeroConf ? 1 : 0}, pay)
        .then(function(result) {
            return [result.utxos, result.fee, result.change];
        })
    );

    return deferred.promise;
};

/**
 * send the transaction using the API
 *
 * @param identifier    string      the wallet identifier
 * @param txHex         string      partially signed transaction as hex string
 * @param paths         array       list of paths used in inputs which should be cosigned by the API
 * @param checkFee      bool        when TRUE the API will verify if the fee is 100% correct and otherwise throw an exception
 * @param [cb]          function    callback(err, txHash)
 * @returns {q.Promise}
 */
APIClient.prototype.sendTransaction = function(identifier, txHex, paths, checkFee, cb) {
    var self = this;

    return self.client.post("/wallet/" + identifier + "/send", {check_fee: checkFee ? 1 : 0}, {raw_transaction: txHex, paths: paths}, cb);
};

/**
 * setup a webhook for this wallet
 *
 * @param identifier        string      the wallet identifier
 * @param webhookIdentifier string      identifier for the webhook
 * @param url               string      URL to receive webhook events
 * @param [cb]              function    callback(err, webhook)
 * @returns {q.Promise}
 */
APIClient.prototype.setupWalletWebhook = function(identifier, webhookIdentifier, url, cb) {
    var self = this;

    return self.client.post("/wallet/" + identifier + "/webhook", null, {url: url, identifier: webhookIdentifier}, cb);
};

/**
 * delete a webhook that was created for this wallet
 *
 * @param identifier        string      the wallet identifier
 * @param webhookIdentifier string      identifier for the webhook
 * @param [cb]              function    callback(err, success)
 * @returns {q.Promise}
 */
APIClient.prototype.deleteWalletWebhook = function(identifier, webhookIdentifier, cb) {
    var self = this;

    return self.client.delete("/wallet/" + identifier + "/webhook/" + webhookIdentifier, null, null, cb);
};

/**
 * get all transactions for an wallet (paginated)
 *
 * @param identifier    string      wallet identifier
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.walletTransactions = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/wallet/" + identifier + "/transactions", params, true, cb);
};

/**
 * get all addresses for an wallet (paginated)
 *
 * @param identifier    string      wallet identifier
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.walletAddresses = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/wallet/" + identifier + "/addresses", params, true, cb);
};

/**
 * get all UTXOs for an wallet (paginated)
 *
 * @param identifier    string      wallet identifier
 * @param [params]      array       pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.walletUTXOs = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/wallet/" + identifier + "/utxos", params, true, cb);
};

/**
 * get a paginated list of all wallets associated with the api user
 *
 * @param [params]      object      pagination: {page: 1, limit: 20}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.allWallets = function(params, cb) {
    var self = this;

    if (typeof params === "function" && typeof cb === "undefined") {
        // mimic function overloading
        cb = params;
        params = null;
    }

    return self.client.get("/wallets", params, true, cb);
};

/**
 * verify a message signed bitcoin-core style
 *
 * @param message        string
 * @param address        string
 * @param signature      string
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.verifyMessage = function(message, address, signature, cb) {
    var self = this;

    // we could also use the API instead of the using bitcoinjs-lib to verify
    // return self.client.post("/verify_message", null, {message: message, address: address, signature: signature}, cb);

    var deferred = q.defer();
    deferred.promise.nodeify(cb);

    try {
        var result = bitcoin.Message.verify(address, signature, message, self.network);
        deferred.resolve(result);
    } catch (e) {
        deferred.reject(e);
    }

    return deferred.promise;
};

/**
 * send a raw transaction
 *
 * @param rawTransaction    string      raw transaction as HEX
 * @param [cb]              function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.sendRawTransaction = function(rawTransaction, cb) {
    var self = this;

    return self.client.post("/send-raw-tx", null, rawTransaction, cb);
};

/**
 * get the current price index
 *
 * @param [cb]          function    callback({'USD': 287.30})
 * @return q.Promise
 */
APIClient.prototype.price = function(cb) {
    var self = this;

    return self.client.get("/price", null, false, cb);
};

module.exports = APIClient;
