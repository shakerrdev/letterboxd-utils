const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => ({
    mode: 'production',
    entry: {
        'content-script': './src/content-script.ts',
        'background': './src/background.ts',
        'options': './src/options.ts'
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'dist'),
        clean: true,
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'static', to: '.' },
                { from: 'manifest.json', to: '.' }
            ],
        }),
    ],
    // Source maps only for development builds; they triple the size of the packaged extension
    devtool: argv.mode === 'development' ? 'inline-source-map' : false
});