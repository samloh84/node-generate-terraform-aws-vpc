const nunjucks = require('nunjucks');
const nodePath = require('path');
const fs = require('fs');
const _ = require('lodash');
const glob = require('glob');
const util = require('util');

const templates_path = nodePath.resolve(process.cwd(), 'templates');
const environment = new nunjucks.Environment(new nunjucks.FileSystemLoader(templates_path), {autoescape: false});
const output_path = nodePath.resolve(process.cwd(), "output");

function clear_output_dir() {
    let file_paths = glob.sync(nodePath.resolve(output_path, "*.*"));
    _.each(file_paths, function (file_path) {
        fs.unlinkSync(file_path);
    });
}

function copy_base_files() {
    _.each(['tf', 'tfvars'], function (extension) {
        let file_paths = glob.sync(nodePath.resolve(templates_path, `*.${extension}`));
        _.each(file_paths, function (file_path) {
            fs.mkdirSync(output_path, {recursive: true});
            fs.writeFileSync(nodePath.resolve(output_path, nodePath.basename(file_path)), fs.readFileSync(file_path));
        });
    });
}


function render_subnets(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let availability_zones = _.get(config, 'availability_zones');

    _.each(network_tiers, function (network_tier, network_tier_index) {
        let context = {};

        if (_.isString(network_tier)) {
            context.network_tier = network_tier;
            context.public = false;
        } else {
            context.network_tier = _.get(network_tier, 'name');
            context.public = !!_.get(network_tier, 'public', false);
        }

        context.network_tier_index = network_tier_index;
        context.availability_zones = availability_zones;

        let rendered_network_tier_subnets = environment.render("subnet.tf.jinja2", context);


        fs.mkdirSync(output_path, {recursive: true});
        fs.writeFileSync(nodePath.resolve(output_path, `subnets_${context.network_tier}_tier.tf`), rendered_network_tier_subnets);
    });

}


function _map_traffic_rule_traffic_types(traffic_type, known_traffic_types) {
    if (!_.isArray(traffic_type)) {
        traffic_type = [traffic_type];
    }

    if (_.includes(traffic_type, 'all')) {
        traffic_type = [{name: 'all', port: 0, protocol: -1}];
    } else {
        traffic_type = _.map(traffic_type, function (traffic_type) {
            if (_.has(known_traffic_types, traffic_type)) {
                let known_traffic_type = _.get(known_traffic_types, traffic_type);
                if (!_.isPlainObject(known_traffic_type)) {
                    return {
                        name: traffic_type,
                        port: known_traffic_type,
                        protocol: 'tcp'
                    };
                } else {
                    return {
                        name: traffic_type,
                        port: _.get(known_traffic_type, 'port'),
                        protocol: _.get(known_traffic_type, 'protocol')
                    };
                }
            } else {
                throw new Error(`Unknown network traffic type: ${traffic_type}`)
            }
        })
    }
    return traffic_type;
}

function _map_traffic_rule_network_tiers(network_tier, network_tiers, known_cidr_ranges) {
    if (!_.isArray(network_tier)) {
        network_tier = [network_tier];
    }

    if (_.includes(network_tier, 'all')) {
        network_tier = _.map(network_tiers, function (network_tier) {
            return {
                name: network_tier,
                is_known_cidr_range: false,
                cidr_block: `local.${network_tier}_tier_cidr_block`
            };
        });
    } else {
        network_tier = _.map(network_tier, function (network_tier) {
            if (_.has(known_cidr_ranges, network_tier)) {
                return {
                    name: network_tier,
                    is_known_cidr_range: true,
                    cidr_block: _.get(known_cidr_ranges, network_tier)
                };
            } else if (_.includes(network_tiers, network_tier)) {
                return {
                    name: network_tier,
                    is_known_cidr_range: false,
                    cidr_block: `local.${network_tier}_tier_cidr_block`
                };
            } else {
                throw new Error(`Unknown network tier: ${network_tier}`)
            }
        });
    }
    return network_tier;
}


function _map_network_tiers(network_tiers) {
    return _.map(network_tiers, function (network_tier) {
        if (_.isString(network_tier)) {
            return network_tier;
        } else {
            return _.get(network_tier, 'name');
        }
    });
}

function _process_network_traffic_rules(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let network_traffic_rules = _.get(config, 'network_traffic_rules');
    let known_traffic_types = _.get(config, 'known_traffic_types');
    let known_cidr_ranges = _.get(config, 'known_cidr_ranges');

    network_tiers = _map_network_tiers(network_tiers);


    network_traffic_rules = _.concat([], network_traffic_rules, _.map(network_tiers, function (network_tier) {
        return {
            source_tier: network_tier,
            destination_tier: network_tier,
            traffic_type_name: 'all'
        };
    }));

    let expanded_network_traffic_rules = [];

    _.each(network_traffic_rules, function (network_traffic_rule) {

        let source_tier = _.get(network_traffic_rule, 'source_tier', 'all');
        let destination_tier = _.get(network_traffic_rule, 'destination_tier', 'all');
        let traffic_type = _.get(network_traffic_rule, 'traffic_type', 'all');

        source_tier = _map_traffic_rule_network_tiers(source_tier, network_tiers, known_cidr_ranges);
        destination_tier = _map_traffic_rule_network_tiers(destination_tier, network_tiers, known_cidr_ranges);
        traffic_type = _map_traffic_rule_traffic_types(traffic_type, known_traffic_types);

        _.each(traffic_type, function (traffic_type) {
            _.each(source_tier, function (source_tier) {
                _.each(destination_tier, function (destination_tier) {
                    let network_traffic_rule = {
                        traffic_type: traffic_type,
                        source_tier: source_tier,
                        destination_tier: destination_tier
                    };

                    expanded_network_traffic_rules.push(network_traffic_rule);
                });
            });
        });
    });

    let grouped_network_traffic_rules = {};
    _.each(expanded_network_traffic_rules, function (network_traffic_rule) {

        let source_tier = _.get(network_traffic_rule, 'source_tier');
        let destination_tier = _.get(network_traffic_rule, 'destination_tier');
        let traffic_type = _.get(network_traffic_rule, 'traffic_type');

        let source_tier_name = _.get(source_tier, 'name');
        let source_tier_is_cidr_range = _.get(source_tier, 'is_known_cidr_range');
        let destination_tier_name = _.get(destination_tier, 'name');
        let destination_tier_is_cidr_range = _.get(destination_tier, 'is_known_cidr_range');
        let traffic_type_name = _.get(traffic_type, 'name');

        if (!source_tier_is_cidr_range) {
            let network_tier_grouping = _.get(grouped_network_traffic_rules, [source_tier_name]);
            if (_.isNil(network_tier_grouping)) {
                network_tier_grouping = {
                    name: source_tier_name,
                    cidr_block: _.get(source_tier, 'cidr_block')
                };
                _.set(grouped_network_traffic_rules, [source_tier_name], network_tier_grouping);
            }

            let egress_traffic_type = _.get(network_tier_grouping, ['egress', traffic_type_name]);
            if (_.isNil(egress_traffic_type)) {
                egress_traffic_type = {
                    name: traffic_type_name,
                    port: _.get(traffic_type, 'port'),
                    protocol: _.get(traffic_type, 'protocol')
                };
                _.set(network_tier_grouping, ['egress', traffic_type_name], egress_traffic_type);
            }

            _.set(egress_traffic_type, [(destination_tier_is_cidr_range ? 'cidr_blocks' : 'network_tiers'), destination_tier_name], {
                name: destination_tier_name,
                cidr_block: _.get(destination_tier, 'cidr_block')
            });
        }
        if (!destination_tier_is_cidr_range) {
            let network_tier_grouping = _.get(grouped_network_traffic_rules, [destination_tier_name]);
            if (_.isNil(network_tier_grouping)) {
                network_tier_grouping = {
                    name: destination_tier_name,
                    cidr_block: _.get(destination_tier, 'cidr_block')
                };
                _.set(grouped_network_traffic_rules, [destination_tier_name], network_tier_grouping);
            }

            let ingress_traffic_type = _.get(network_tier_grouping, ['ingress', traffic_type_name]);
            if (_.isNil(ingress_traffic_type)) {
                ingress_traffic_type = {
                    name: traffic_type_name,
                    port: _.get(traffic_type, 'port'),
                    protocol: _.get(traffic_type, 'protocol')
                };
                _.set(network_tier_grouping, ['ingress', traffic_type_name], ingress_traffic_type);
            }

            _.set(ingress_traffic_type, [(source_tier_is_cidr_range ? 'cidr_blocks' : 'network_tiers'), source_tier_name], {
                name: source_tier_name,
                cidr_block: _.get(source_tier, 'cidr_block')
            });
        }
    });

    return grouped_network_traffic_rules;
}


function render_security_groups(config) {
    let network_traffic_rules = _process_network_traffic_rules(config);


    let security_groups = [];

    _.each(network_traffic_rules, function (network_tier_grouping, network_tier_name) {
        let security_group_name = `${network_tier_name}_tier`;
        let security_group = {
            name: security_group_name,
            network_tier_name: network_tier_name
        };

        let rules = [];

        _.each(_.get(network_tier_grouping, 'ingress'), function (ingress_traffic_type, ingress_traffic_type_name) {

            if (_.has(ingress_traffic_type, 'network_tiers')) {
                _.each(_.sortedUniq(_.sortBy(_.map(_.get(ingress_traffic_type, 'network_tiers'), 'name'))), function (network_tier) {
                    rules.push({
                        name: `${security_group_name}_${ingress_traffic_type_name}_ingress_from_${network_tier}_tiers`,
                        type: 'ingress',
                        traffic_type_name: ingress_traffic_type_name,
                        port: _.get(ingress_traffic_type, 'port'),
                        protocol: _.get(ingress_traffic_type, 'protocol'),
                        network_tier: network_tier
                    });
                });
            }

            if (_.has(ingress_traffic_type, 'cidr_blocks')) {
                rules.push({
                    name: `${security_group_name}_${ingress_traffic_type_name}_ingress_from_cidr_blocks`,
                    type: 'ingress',
                    traffic_type_name: ingress_traffic_type_name,
                    port: _.get(ingress_traffic_type, 'port'),
                    protocol: _.get(ingress_traffic_type, 'protocol'),
                    cidr_blocks: _.sortedUniq(_.sortBy(_.map(_.get(ingress_traffic_type, 'cidr_blocks'), 'cidr_block')))
                })
            }

        });

        _.each(_.get(network_tier_grouping, 'egress'), function (egress_traffic_type, egress_traffic_type_name) {

            if (_.has(egress_traffic_type, 'network_tiers')) {
                _.each(_.sortedUniq(_.sortBy(_.map(_.get(egress_traffic_type, 'network_tiers'), 'name'))), function (network_tier) {
                    rules.push({
                        name: `${security_group_name}_${egress_traffic_type_name}_egress_to_${network_tier}_tier`,
                        type: 'egress',
                        traffic_type_name: egress_traffic_type_name,
                        port: _.get(egress_traffic_type, 'port'),
                        protocol: _.get(egress_traffic_type, 'protocol'),
                        network_tier: network_tier
                    })
                });

            }

            if (_.has(egress_traffic_type, 'cidr_blocks')) {
                rules.push({
                    name: `${security_group_name}_${egress_traffic_type_name}_egress_to_cidr_blocks`,
                    type: 'egress',
                    traffic_type_name: egress_traffic_type_name,
                    port: _.get(egress_traffic_type, 'port'),
                    protocol: _.get(egress_traffic_type, 'protocol'),
                    cidr_blocks: _.sortedUniq(_.sortBy(_.map(_.get(egress_traffic_type, 'cidr_blocks'), 'cidr_block')))
                })
            }

        });

        security_group.rules = rules;

        security_groups.push(security_group);
    });

    debug_log(security_groups);

    _.each(security_groups, function (security_group) {
        let context = _.merge({}, security_group);

        let rendered_security_group = environment.render("security_group.tf.jinja2", context);

        fs.mkdirSync(output_path, {recursive: true});
        fs.writeFileSync(nodePath.resolve(output_path, `security_group_${context.name}.tf`), rendered_security_group);
    });
}


function render_network_acls(config) {
    let network_tiers = _map_network_tiers(_.get(config, 'network_tiers'));
    let network_traffic_rules = _process_network_traffic_rules(config);
    let availability_zones = _.get(config, 'availability_zones');

    let network_acls = [];

    _.each(network_traffic_rules, function (network_tier_grouping, network_tier_name) {

        let network_acl_name = `${network_tier_name}_tier`;
        let network_acl = {
            name: network_acl_name,
            network_tier_name: network_tier_name,
            availability_zones: availability_zones
        };

        let rules = [];

        _.each(_.get(network_tier_grouping, 'ingress'), function (ingress_traffic_type, ingress_traffic_type_name) {

            let cidr_blocks = _.sortedUniq(_.sortBy(_.concat([], _.map(_.get(ingress_traffic_type, 'network_tiers'), 'cidr_block'), _.map(_.get(ingress_traffic_type, 'cidr_blocks'), 'cidr_block'))));

            let rule = {
                name: `${network_acl_name}_${ingress_traffic_type_name}_ingress`,
                network_tier_name: network_tier_name,
                egress: false,
                traffic_type_name: ingress_traffic_type_name,
                port: _.get(ingress_traffic_type, 'port'),
                protocol: _.get(ingress_traffic_type, 'protocol'),
                cidr_blocks: cidr_blocks
            };
            rules.push(rule);
        });

        _.each(_.get(network_tier_grouping, 'egress'), function (egress_traffic_type, egress_traffic_type_name) {
            let cidr_blocks = _.sortedUniq(_.sortBy(_.concat([], _.map(_.get(egress_traffic_type, 'network_tiers'), 'cidr_block'), _.map(_.get(egress_traffic_type, 'cidr_blocks'), 'cidr_block'))));

            let rule = {
                name: `${network_acl_name}_${egress_traffic_type_name}_egress`,
                network_tier_name: network_tier_name,
                egress: true,
                traffic_type_name: egress_traffic_type_name,
                port: _.get(egress_traffic_type, 'port'),
                protocol: _.get(egress_traffic_type, 'protocol'),
                cidr_blocks: cidr_blocks
            };
            rules.push(rule);
        });

        network_acl.rules = rules;
        network_acls.push(network_acl);
    });

    debug_log(network_acls);

    _.each(network_acls, function (network_acl) {
        let context = _.merge({}, network_acl);

        let rendered_network_acl = environment.render("network_acl.tf.jinja2", context);

        fs.mkdirSync(output_path, {recursive: true});
        fs.writeFileSync(nodePath.resolve(output_path, `network_acl_${context.name}.tf`), rendered_network_acl);
    });
}


function render_internet_gateway(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let availability_zones = _.get(config, 'availability_zones');

    let context = {};
    context.public_network_tiers = [];
    context.availability_zones = availability_zones;

    _.each(network_tiers, function (network_tier) {
        if (_.isPlainObject(network_tier)) {
            if (!!_.get(network_tier, 'public', false)) {
                context.public_network_tiers.push(_.get(network_tier, 'name'));
            }
        }
    });

    let rendered_internet_gateway = environment.render("internet_gateway.tf.jinja2", context);

    fs.mkdirSync(output_path, {recursive: true});
    fs.writeFileSync(nodePath.resolve(output_path, `internet_gateway.tf`), rendered_internet_gateway);
}


function render_nat_gateways(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let availability_zones = _.get(config, 'availability_zones');

    let context = {};
    context.public_network_tiers = [];
    context.private_network_tiers = [];
    context.availability_zones = availability_zones;

    _.each(network_tiers, function (network_tier) {
        if (_.isPlainObject(network_tier)) {
            if (!!_.get(network_tier, 'public', false)) {
                context.public_network_tiers.push(_.get(network_tier, 'name'));
            } else {
                context.private_network_tiers.push(_.get(network_tier, 'name'));
            }
        } else {
            context.private_network_tiers.push(network_tier);
        }
    });

    context.public_network_tier = _.first(context.public_network_tiers);

    let rendered_nat_gateways = environment.render("nat_gateways.tf.jinja2", context);

    fs.mkdirSync(output_path, {recursive: true});
    fs.writeFileSync(nodePath.resolve(output_path, `nat_gateways.tf`), rendered_nat_gateways);
}



function render_main(config) {
    let region = _.get(config, 'region');

    let context = {};
    context.region = region;

    let rendered_main = environment.render("main.tf.jinja2", context);

    fs.mkdirSync(output_path, {recursive: true});
    fs.writeFileSync(nodePath.resolve(output_path, `main.tf`), rendered_main);
}


module.exports = {
    clear_output_dir: clear_output_dir,
    copy_base_files: copy_base_files,
    render_subnets: render_subnets,
    render_network_acls: render_network_acls,
    render_security_groups: render_security_groups,
    render_internet_gateway: render_internet_gateway,
    render_nat_gateways: render_nat_gateways,
    render_main: render_main,
    render: render
};

function debug_log(obj) {
    console.log(util.inspect(obj, {showHidden: false, depth: null}))
}


function render(config) {
    clear_output_dir();
    copy_base_files();
    render_main(config);
    render_subnets(config);
    render_network_acls(config);
    render_security_groups(config);
    render_internet_gateway(config);
    render_nat_gateways(config);
}
