const YAML = require('js-yaml');
const fs = require('fs');
const nodePath = require('path');


function parse(path){
    path = nodePath.resolve(process.cwd(), path);
    let document = fs.readFileSync(path,'utf8');
    return YAML.safeLoad(document);
}

module.exports = {
    parse:parse
};