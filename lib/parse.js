const YAML = require('js-yaml');
const fs = require('fs');
const nodePath = require('path');
const _ = require('lodash');

function _deep_inspect(obj) {
    return JSON.stringify(obj, null, 4);
}

function parse(path) {
    path = nodePath.resolve(process.cwd(), path);
    let document = fs.readFileSync(path, 'utf8');
    let config = YAML.safeLoad(document);
    config = normalize_config(config);
    return config;
}


function normalize_config(config) {
    let cidr = _.get(config, 'cidr');
    let region = _.get(config, 'region');
    let network_tiers = _.get(config, 'network_tiers');
    let known_traffic_types = _.get(config, 'known_traffic_types');
    let known_cidr_ranges = _.get(config, 'known_cidr_ranges');
    let network_traffic_rules = _.get(config, 'network_traffic_rules');
    let availability_zones = _.get(config, 'availability_zones');

    let normalized_network_tiers = {};

    _.each(network_tiers, function (network_tier) {

        let normalized_network_tier;
        if (_.isString(network_tier)) {
            normalized_network_tier = {
                name: network_tier,
                public: false,
                external: false,
                is_known_cidr_range: false,
                cidr_block: `local.${network_tier}_tier_cidr_block`
            };
        } else if (_.isPlainObject(network_tier)) {
            let name = _.get(network_tier, 'name');
            let is_public = !!_.get(network_tier, 'public', false);
            normalized_network_tier = {
                name: name,
                public: is_public,
                external: false,
                is_known_cidr_range: false,
                cidr_block: `local.${name}_tier_cidr_block`
            }
        } else {
            throw new Error(`Unable to parse known traffic type: ${_deep_inspect(traffic_type)}`);
        }
        _.set(normalized_network_tiers, normalized_network_tier.name, normalized_network_tier);
    });

    let public_network_tiers = _.map(_.filter(normalized_network_tiers, {public: true}), 'name');
    let private_network_tiers = _.map(_.filter(normalized_network_tiers, {public: false}), 'name');
    let nat_gateway_network_tier = _.first(public_network_tiers);

    let normalized_known_cidr_ranges = {};
    _.each(known_cidr_ranges, function (cidr_range, name) {
        let normalized_known_cidr_range = {
            name: name,
            public: false,
            external: true,
            is_known_cidr_range: true,
            cidr_block: cidr_range
        };
        _.set(normalized_known_cidr_ranges, normalized_known_cidr_range.name, normalized_known_cidr_range);
    });


    let normalized_known_traffic_types = {};
    _.each(known_traffic_types, function (traffic_type, name) {
        let normalized_known_traffic_type;
        if (_.isString(traffic_type) || _.isInteger(traffic_type)) {
            normalized_known_traffic_type = {
                name: name,
                port: traffic_type,
                protocol: 'tcp'
            };
        } else if (_.isPlainObject(traffic_type)) {
            normalized_known_traffic_type = {
                name: traffic_type,
                port: _.get(traffic_type, 'port'),
                protocol: _.get(traffic_type, 'protocol')
            };
        } else {
            throw new Error(`Unable to parse known traffic type: ${_deep_inspect(traffic_type)}`);
        }
        _.set(normalized_known_traffic_types, normalized_known_traffic_type.name, normalized_known_traffic_type);
    });

    function map_traffic_rule_network_tiers(network_tiers) {
        if (!_.isArray(network_tiers)) {
            network_tiers = [network_tiers];
        }

        network_tiers = _.sortedUniq(_.uniq(network_tiers));

        return _.flatten(_.map(network_tiers, function (network_tier) {
            if (_.includes(network_tiers, 'all')) {
                return _.values(normalized_network_tiers);
            } else if (_.has(normalized_network_tiers, network_tier)) {
                return _.get(normalized_network_tiers, network_tier)
            } else if (_.has(normalized_known_cidr_ranges, network_tier)) {
                return _.get(normalized_known_cidr_ranges, network_tier)
            } else {
                throw new Error(`Unknown network tier: ${network_tier}`);
            }
        }));
    }

    function map_traffic_rule_traffic_type(traffic_types) {
        if (!_.isArray(traffic_types)) {
            traffic_types = [traffic_types];
        }

        traffic_types = _.sortedUniq(_.uniq(traffic_types));

        return _.flatten(_.map(traffic_types, function (traffic_type) {
            if (_.includes(traffic_types, 'all')) {
                return {
                    name: 'all',
                    port: 0,
                    protocol: -1
                }
            } else if (_.has(normalized_known_traffic_types, traffic_type)) {
                return _.get(normalized_known_traffic_types, traffic_type)
            } else {
                throw new Error(`Unknown network traffic type: ${traffic_type}`);
            }
        }));
    }

    let allow_all_to_self_network_traffic_rules = _.map(_.keys(normalized_network_tiers), function (network_tier) {
        return {
            source_tier: network_tier,
            destination_tier: network_tier,
            traffic_type: 'all'
        };
    });


    network_traffic_rules = _.concat([], network_traffic_rules, allow_all_to_self_network_traffic_rules);

    let grouped_network_traffic_rules = {};

    _.each(network_traffic_rules, function (network_traffic_rule) {
        let source_tiers = _.get(network_traffic_rule, 'source_tier');
        let destination_tiers = _.get(network_traffic_rule, 'destination_tier');
        let traffic_types = _.get(network_traffic_rule, 'traffic_type');

        source_tiers = map_traffic_rule_network_tiers(source_tiers);
        destination_tiers = map_traffic_rule_network_tiers(destination_tiers);
        traffic_types = map_traffic_rule_traffic_type(traffic_types);
        _.each(source_tiers, function (source_tier) {
            _.each(destination_tiers, function (destination_tier) {
                _.each(traffic_types, function (traffic_type) {
                    _.set(grouped_network_traffic_rules, [source_tier.name, traffic_type.name, destination_tier.name], {
                        source_tier: source_tier,
                        destination_tier: destination_tier,
                        traffic_type: traffic_type
                    });
                });
            });
        });
    });

    let paths_to_prune = [];

    _.each(_.keys(grouped_network_traffic_rules), function (source_tier_name) {
        _.each(_.keys(_.get(grouped_network_traffic_rules, [source_tier_name])), function (traffic_type_name) {
            _.each(_.keys(_.get(grouped_network_traffic_rules, [source_tier_name, traffic_type_name])), function (destination_tier_name) {

                let prune = false;
                if (_.has(grouped_network_traffic_rules, ['all', traffic_type_name, destination_tier_name] && source_tier_name !== 'all')) {
                    prune = true;
                }

                if (_.has(grouped_network_traffic_rules, [source_tier_name, traffic_type_name, 'all'] && destination_tier_name !== 'all')) {
                    prune = true;
                }

                if (_.has(grouped_network_traffic_rules, [source_tier_name, 'all', destination_tier_name] && traffic_type_name !== 'all')) {
                    prune = true;
                }

                // TODO: Add CIDR block here.
                // TODO: Map to network port range and see if either is in range

                if (prune) {
                    paths_to_prune.push([source_tier_name, traffic_type_name, destination_tier_name]);
                }

            });
        });
    });

    _.each(paths_to_prune, function (path_to_prune) {
        _.unset(grouped_network_traffic_rules, path_to_prune);
    });

    let flattened_network_traffic_rules = [];
    let expanded_network_traffic_rules = [];
    let grouped_expanded_network_traffic_rules = {};
    _.each(grouped_network_traffic_rules, function (source_tier_traffic_rules) {
        _.each(source_tier_traffic_rules, function (traffic_type_traffic_rules) {
            _.each(traffic_type_traffic_rules, function (traffic_rule) {
                flattened_network_traffic_rules.push(traffic_rule);

                let source_tier = traffic_rule.source_tier;
                let destination_tier = traffic_rule.destination_tier;
                let traffic_type = traffic_rule.traffic_type;

                if (!source_tier.is_known_cidr_range) {
                    let network_tier = source_tier;
                    let associated_network_tier = destination_tier;
                    let traffic_rule_direction = 'egress';
                    let traffic_rule_network_tier_type = associated_network_tier.is_known_cidr_range ? 'cidr_block' : 'network_tier';

                    let expanded_network_traffic_rule = {
                        source_tier: source_tier,
                        destination_tier: destination_tier,
                        network_tier: network_tier,
                        associated_network_tier: associated_network_tier,
                        traffic_type: traffic_type,
                        traffic_rule_direction: traffic_rule_direction,
                        traffic_rule_network_tier_type: traffic_rule_network_tier_type
                    };

                    _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'network_tier'], source_tier);
                    _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'rules', traffic_rule_direction, traffic_type.name, 'traffic_type'], traffic_type);
                    _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'rules', traffic_rule_direction, traffic_type.name, 'rules', traffic_rule_network_tier_type + 's', associated_network_tier.name], expanded_network_traffic_rule);

                    expanded_network_traffic_rules.push(expanded_network_traffic_rule);
                }
                if (!destination_tier.is_known_cidr_range) {
                    let network_tier = destination_tier;
                    let associated_network_tier = source_tier;
                    let traffic_rule_direction = 'ingress';
                    let traffic_rule_network_tier_type = associated_network_tier.is_known_cidr_range ? 'cidr_block' : 'network_tier';

                    let expanded_network_traffic_rule = {
                        source_tier: source_tier,
                        destination_tier: destination_tier,
                        network_tier: network_tier,
                        associated_network_tier: associated_network_tier,
                        traffic_type: traffic_type,
                        traffic_rule_direction: traffic_rule_direction,
                        traffic_rule_network_tier_type: traffic_rule_network_tier_type
                    };

                    _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'network_tier'], source_tier);
                    _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'rules', traffic_rule_direction, traffic_type.name, 'traffic_type'], traffic_type);
                    _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'rules', traffic_rule_direction, traffic_type.name, 'rules', traffic_rule_network_tier_type + 's', associated_network_tier.name], expanded_network_traffic_rule);

                    expanded_network_traffic_rules.push(expanded_network_traffic_rule);
                }


            });

        });
    });


    return {
        cidr: cidr,
        region: region,
        availability_zones: availability_zones,
        network_tiers: normalized_network_tiers,
        public_network_tiers: public_network_tiers,
        private_network_tiers: private_network_tiers,
        nat_gateway_network_tier: nat_gateway_network_tier,
        known_cidr_ranges: normalized_known_cidr_ranges,
        known_traffic_types: normalized_known_traffic_types,
        network_traffic_rules: flattened_network_traffic_rules,
        grouped_network_traffic_rules: grouped_network_traffic_rules,
        expanded_network_traffic_rules: expanded_network_traffic_rules,
        grouped_expanded_network_traffic_rules: grouped_expanded_network_traffic_rules
    };
}

module.exports = {parse: parse};