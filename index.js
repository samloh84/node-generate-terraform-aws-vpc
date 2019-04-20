const parse = require('./lib/parse');
const render = require('./lib/render');
let config = parse.parse('config.yaml');

render.render(config);