var _ = require('lodash');
var Request = require('./request');

/**
 * Intermediate class to create HTTP requests
 *
 *
 * @param options       object{
 *                          host: '',
 *                          endpoint: '', // base url for .request
 *                          apiKey: 'API_KEY',
 *                          apiSecret: 'API_SECRET'
 *                      }
 * @constructor
 * @constructor
 */
var RestClient = function(options) {
    var self = this;

    if (!(self instanceof RestClient)) {
        return new RestClient(options);
    }

    self.apiKey = options.apiKey;
    self.apiSecret = options.apiSecret;
    self.https = options.https;
    self.host = options.host;
    self.port = options.port;
    self.endpoint = options.endpoint;

    self.defaultParams = {
        'api_key': self.apiKey
    };

    self.defaultHeaders = {
        'X-SDK-Version': 'blocktrail-sdk-nodejs/1.3.x'
    };

    self.HTTP_SIGNATURE = RestClient.HTTP_SIGNATURE;
};

RestClient.HTTP_SIGNATURE = Request.HTTP_SIGNATURE;

RestClient.prototype.create_request = function(options) {
    var self = this;

    options = _.defaults({}, options, {
        https: self.https,
        host: self.host,
        port: self.port,
        endpoint: self.endpoint,
        apiKey: self.apiKey,
        apiSecret: self.apiSecret,
        params: _.defaults({}, self.defaultParams),
        headers: _.defaults({}, self.defaultHeaders)
    });

    return new Request(options);
};

RestClient.prototype.post = function(path, params, data, options, fn) {
    if (typeof options === "function") {
        fn = options;
        options = {};
    }
    
    options = _.merge({}, {auth: RestClient.HTTP_SIGNATURE}, options || {});

    return this.create_request(options).request('POST', path, params, data, fn);
};

RestClient.prototype.put = function(path, params, data, options, fn) {
    if (typeof options === "function") {
        fn = options;
        options = {};
    }

    options = _.merge({}, {auth: RestClient.HTTP_SIGNATURE}, options || {});

    return this.create_request(options).request('PUT', path, params, data, fn);
};

RestClient.prototype.get = function(path, params, options, fn) {
    if (typeof options === "function") {
        fn = options;
        options = {};
    }

    options = _.merge({}, options || {});

    return this.create_request(options).request('GET', path, params, null, fn);
};

RestClient.prototype.delete = function(path, params, data, options, fn) {
    if (typeof options === "function") {
        fn = options;
        options = {};
    }

    options = _.merge({}, {auth: RestClient.HTTP_SIGNATURE}, options || {});

    return this.create_request(options).request('DELETE', path, params, data, fn);
};

module.exports = RestClient;
