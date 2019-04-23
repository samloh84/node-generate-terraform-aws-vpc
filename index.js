#!/usr/bin/env node

const parse = require('./lib/parse');
const render = require('./lib/render');
const commander = require('commander');
const nodePath = require('path');
const _ = require('lodash');
const util =require('util');


let config_path = nodePath.resolve(process.cwd(), 'config.yaml');
commander
    .version('0.1.1')
    .arguments('[config_path]')
    .action(render_output);

commander.parse(process.argv);

function render_output(arg_config_path) {
    if (_.isNil(arg_config_path)) {
        console.log(`Config path not specified, defaulting to : ${config_path}`);
    } else {
        config_path = nodePath.resolve(process.cwd(), arg_config_path);
        console.log(`Config path: ${config_path}`);
    }
}



function debug_log(obj) {
    console.error(JSON.stringify(obj, null, 4))
}

let config = parse.parse(config_path);
debug_log(config);

render.render(config);

