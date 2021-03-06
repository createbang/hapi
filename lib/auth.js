// Load modules

var Boom = require('boom');
var Hoek = require('hoek');
var Schema = require('./schema');


// Declare internals

var internals = {};


exports = module.exports = internals.Auth = function (connection) {

    this.connection = connection;
    this._schemes = {};
    this._strategies = {};
    this.settings = {
        default: null           // Strategy used as default if route has no auth settings
    };
};


internals.Auth.prototype.scheme = function (name, scheme) {

    Hoek.assert(name, 'Authentication scheme must have a name');
    Hoek.assert(!this._schemes[name], 'Authentication scheme name already exists:', name);
    Hoek.assert(typeof scheme === 'function', 'scheme must be a function:', name);

    this._schemes[name] = scheme;
};


internals.Auth.prototype.strategy = function (name, scheme /*, mode, options */) {

    var hasMode = (typeof arguments[2] === 'string' || typeof arguments[2] === 'boolean');
    var mode = (hasMode ? arguments[2] : false);
    var options = (hasMode ? arguments[3] : arguments[2]) || null;

    Hoek.assert(name, 'Authentication strategy must have a name');
    Hoek.assert(name !== 'bypass', 'Cannot use reserved strategy name: bypass');
    Hoek.assert(!this._strategies[name], 'Authentication strategy name already exists');
    Hoek.assert(scheme, 'Authentication strategy', name, 'missing scheme');
    Hoek.assert(this._schemes[scheme], 'Authentication strategy', name, 'uses unknown scheme:', scheme);

    this._strategies[name] = this._schemes[scheme](this.connection, options);
    this._strategies[name].options = this._strategies[name].options || {};
    Hoek.assert(this._strategies[name].payload || !this._strategies[name].options.payload, 'Cannot require payload validation without a payload method');

    if (mode) {
        this.default({ strategies: [name], mode: mode === true ? 'required' : mode });
    }
};


internals.Auth.prototype.default = function (options) {

    Schema.assert('auth', options, 'default strategy');
    Hoek.assert(!this.settings.default, 'Cannot set default strategy more than once');

    var settings = Hoek.clone(options);             // options can be reused

    if (typeof settings === 'string') {
        settings = {
            strategies: [settings],
            mode: 'required'
        };
    }
    else if (settings.strategy) {
        settings.strategies = [settings.strategy];
        delete settings.strategy;
    }

    Hoek.assert(settings.strategies && settings.strategies.length, 'Default authentication strategy missing strategy name');

    this.settings.default = settings;
};


internals.Auth.prototype.test = function (name, request, next) {

    Hoek.assert(name, 'Missing authentication strategy name');
    var strategy = this._strategies[name];
    Hoek.assert(strategy, 'Unknown authentication strategy:', name);

    var transfer = function (response, data) {

        return next(response, data && data.credentials);
    };

    var reply = request.server._replier.interface(request, transfer);
    strategy.authenticate(request, reply);
};


internals.Auth.prototype._setupRoute = function (options, path) {

    var self = this;

    if (!options) {
        return options;         // Preseve the difference between undefined and false
    }

    if (typeof options === 'string') {
        options = { strategies: [options] };
    }
    else if (options.strategy) {
        options.strategies = [options.strategy];
        delete options.strategy;
    }

    if (!options.strategies) {
        Hoek.assert(this.settings.default, 'Route missing authentication strategy and no default defined:', path);
        options = Hoek.applyToDefaults(this.settings.default, options);
    }

    Hoek.assert(options.strategies.length, 'Route missing authentication strategy:', path);

    options.mode = options.mode || 'required';
    if (options.payload === true) {
        options.payload = 'required';
    }

    var hasAuthenticatePayload = false;
    options.strategies.forEach(function (name) {

        var strategy = self._strategies[name];
        Hoek.assert(strategy, 'Unknown authentication strategy:', name, 'in path:', path);
        var payloadSupported = typeof strategy.payload === 'function';
        Hoek.assert(payloadSupported || options.payload !== 'required', 'Payload validation can only be required when all strategies support it in path:', path);
        hasAuthenticatePayload = hasAuthenticatePayload || payloadSupported;
        Hoek.assert(!strategy.options.payload || options.payload === undefined || options.payload === 'required', 'Cannot set authentication payload to', options.payload, 'when a strategy requires payload validation', path);
    });

    Hoek.assert(!options.payload || hasAuthenticatePayload, 'Payload authentication requires at least one strategy with payload support in path:', path);

    return options;
};


internals.Auth.prototype._routeConfig = function (request) {

    if (request.route.auth === false) {
        return false;
    }

    return request.route.auth || this.settings.default;
};


internals.Auth.authenticate = function (request, next) {

    var auth = request.connection.auth;
    return auth._authenticate(request, next);
};


internals.Auth.prototype._authenticate = function (request, next) {

    var self = this;

    var config = this._routeConfig(request);
    if (!config) {
        return next();
    }

    request.auth.mode = config.mode;

    var authErrors = [];
    var strategyPos = 0;

    var authenticate = function () {

        // Find next strategy

        if (strategyPos >= config.strategies.length) {
            var err = Boom.unauthorized('Missing authentication', authErrors);

            if (config.mode === 'optional' ||
                config.mode === 'try') {

                request.auth.isAuthenticated = false;
                request.auth.credentials = null;
                request.auth.error = err;
                request._log(['auth', 'unauthenticated']);
                return next();
            }

            return next(err);
        }

        var strategy = config.strategies[strategyPos];
        ++strategyPos;

        request._protect.run('auth:request:' + strategy, validate, function (exit) {

            var transfer = function (response, data) {

                exit(response, strategy, data);
            };

            var reply = request.server._replier.interface(request, transfer);
            self._strategies[strategy].authenticate(request, reply);
        });
    };

    var validate = function (err, strategy, result) {           // err can be Boom, Error, or a valid response object

        if (!strategy) {
            return next(err);
        }

        result = result || {};

        // Unauthenticated

        if (!err &&
            !result.credentials) {

            return next(Boom.badImplementation('Authentication response missing both error and credentials'));
        }

        if (err) {
            if (err instanceof Error === false) {
                request._log(['auth', 'unauthenticated', 'response', strategy], err.statusCode);
                return next(err);
            }

            request._log(['auth', 'unauthenticated', 'error', strategy], err);

            if (err.isMissing) {

                // Try next strategy

                authErrors.push(err.output.headers['WWW-Authenticate']);
                return authenticate();
            }

            if (config.mode === 'try') {
                request.auth.isAuthenticated = false;
                request.auth.strategy = strategy;
                request.auth.credentials = result.credentials;
                request.auth.artifacts = result.artifacts;
                request.auth.error = err;
                request._log(['auth', 'unauthenticated', 'try', strategy], err);
                return next();
            }

            return next(err);
        }

        // Authenticated

        var credentials = result.credentials;
        request.auth.strategy = strategy;
        request.auth.credentials = credentials;
        request.auth.artifacts = result.artifacts;

        // Check scope

        if (config.scope) {
            if (!credentials.scope ||
                (typeof config.scope === 'string' ?
                    (typeof credentials.scope === 'string' ? config.scope !== credentials.scope : credentials.scope.indexOf(config.scope) === -1) :
                    (typeof credentials.scope === 'string' ? config.scope.indexOf(credentials.scope) === -1 : !Hoek.intersect(config.scope, credentials.scope).length))) {

                request._log(['auth', 'scope', 'error', strategy], { got: credentials.scope, need: config.scope });
                return next(Boom.forbidden('Insufficient scope, expected any of: ' + config.scope));
            }
        }

        // Check entity

        var entity = config.entity || 'any';

        // Entity: 'any'

        if (entity === 'any') {
            request._log(['auth', strategy]);
            request.auth.isAuthenticated = true;
            return next();
        }

        // Entity: 'user'

        if (entity === 'user') {
            if (!credentials.user) {
                request._log(['auth', 'entity', 'user', 'error', strategy]);
                return next(Boom.forbidden('Application credentials cannot be used on a user endpoint'));
            }

            request._log(['auth', strategy]);
            request.auth.isAuthenticated = true;
            return next();
        }

        // Entity: 'app'

        if (credentials.user) {
            request._log(['auth', 'entity', 'app', 'error', strategy]);
            return next(Boom.forbidden('User credentials cannot be used on an application endpoint'));
        }

        request._log(['auth', strategy]);
        request.auth.isAuthenticated = true;
        return next();
    };

    // Injection bypass

    if (request.auth.credentials) {
        return validate(null, 'bypass', { credentials: request.auth.credentials });
    }

    // Authenticate

    authenticate();
};


internals.Auth.payload = function (request, next) {

    if (!request.auth.isAuthenticated ||
        request.auth.strategy === 'bypass') {

        return next();
    }

    var auth = request.connection.auth;
    var strategy = auth._strategies[request.auth.strategy];

    if (!strategy.payload) {
        return next();
    }

    var config = auth._routeConfig(request);
    var setting = config.payload || (strategy.options.payload ? 'required' : false);
    if (!setting) {
        return next();
    }

    var finalize = function (response) {

        if (response &&
            response.isBoom &&
            response.isMissing) {

            return next(setting === 'optional' ? null : Boom.unauthorized('Missing payload authentication'));
        }

        return next(response);
    };

    request._protect.run('auth:payload:' + request.auth.strategy, finalize, function (exit) {

        var reply = request.server._replier.interface(request, exit);
        strategy.payload(request, reply);
    });
};


internals.Auth.response = function (request, next) {

    var auth = request.connection.auth;
    var config = auth._routeConfig(request);
    if (!config ||
        !request.auth.isAuthenticated ||
        request.auth.strategy === 'bypass') {

        return next();
    }

    var strategy = auth._strategies[request.auth.strategy];
    if (typeof strategy.response !== 'function') {
        return next();
    }

    request._protect.run('auth:response:' + request.auth.strategy, next, function (exit) {

        var reply = request.server._replier.interface(request, exit);
        strategy.response(request, reply);
    });
};
