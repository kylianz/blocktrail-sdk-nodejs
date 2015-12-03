var blocktrail = require('../'); // require('blocktrail-sdk') when trying example from in your own project
var bitcoin = blocktrail.bitcoin;

var client = blocktrail.BlocktrailSDK({
    apiKey: "56e781972fa0b820da60abc8a04761boaa32eds",
    apiSecret: "adaa6250d05cb35bb970e9e6c2a0d287eec76a0d",
    
});

client.initWallet({
    identifier: "5918c5f14dc9b960",
    
}, function(err, wallet) {
    if (err) {
        console.log(err);
        return;
    }

    wallet.getNewAddress(function(err, selfAddress) {
        if (err) {
            console.log(err);
            return;
        }

        var allowZeroConf = true;
        var allowZeroConfSelf = true;
        var feeStrategy = blocktrail.Wallet.FEE_STRATEGY_BASE_FEE;
        // var feeStrategy = blocktrail.Wallet.FEE_STRATEGY_OPTIMAL;
        var options = {
            allowZeroConfSelf: allowZeroConfSelf
        };

        wallet.maxSpendable(allowZeroConf, feeStrategy, options, function(err, maxSpendable) {
            if (err) {
                console.log(err);
                return;
            }

            console.log(maxSpendable);

            wallet.unlock({passphrase: "example-strong-password"}, function(err) {
                if (err) {
                    console.log(err);
                    return;
                }

                var pay = {};
                pay[selfAddress] = maxSpendable.max;

                wallet.pay(pay, function(err, txHash) {
                    if (err) {
                        console.log(err);
                        return;
                    }

                    console.log(txHash);
                });
            });
        });
    });
});
