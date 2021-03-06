const Telegraf = require('telegraf');
const request = require('request');
const WS = require('ws');
const ReconnectingWebSocket = require('reconnecting-websocket');
const { diff } = require('just-diff');
const dataService = require('./dataService');
const config = require('./config.json');
const _ = require('lodash');
const extra = require('telegraf/extra')
const markup = extra.markdown()


const wsOptions = {
  WebSocket: WS,
};

const newBlockHeaderSubscription = {
    "method": "subscribe",
    "params": ["tm.event='NewBlockHeader'"],
    "jsonrpc": "2.0"
}

const bot = new Telegraf(config.tokenbot, {
  telegram: {
    webhookReply: false,
  },
});
bot.telegram.getMe().then((botInfo) => {
    bot.options.username = botInfo.username;
    console.log("Initialized", botInfo.username);
});

dataService.loadUsers();
bot.launch();

let lastState = {};
let newState = {};
let changes = [];
let lastBlockTimestamp;
let lastBlockTime;

const wsCyber = new ReconnectingWebSocket(config.cyberdnodeWS, [], wsOptions);

wsCyber.addEventListener('open', async () => {
    try { 
        request(config.cybernodeLCD+'/staking/validators', function (error, response, data) {
            data = JSON.parse(data).result;
            // need to cast alert if diff more than one block for debugging
            for(i = 0; i < data.length; i++) {
                newState[data[i].operator_address] = data[i];
            }
            lastState = newState;
            wsCyber.send(JSON.stringify(newBlockHeaderSubscription));
        });
    } catch (e) {
        console.log(e);
    }
});

wsCyber.addEventListener('message', async (msg) => {
    try {
        console.log(JSON.parse(msg.data).result.data.value.header.time);
        let blockTime = Date.parse(JSON.parse(msg.data).result.data.value.header.time) / 1000
        lastBlockTime = blockTime - lastBlockTimestamp
        lastBlockTimestamp = blockTime;
        request(config.cybernodeLCD+'/staking/validators', function (error, response, data) {
            data = JSON.parse(data).result;
            for(i = 0; i < data.length; i++) {
                newState[data[i].operator_address] = data[i];
            }
            changes = diff(lastState, newState);
            console.log("changes", changes);
            if (changes.length != 0) {
                changes.forEach(function(item) {
                    if (item.op == 'replace') {
                        switch(item.path[1]) {
                            case 'jailed':
                                sendJailChangedMessage(item.path[0]);
                                break;
                            case 'delegator_shares':
                                sendDelegationChangedMessage(item.path[0]);
                                break;
                            case 'status':
                                sendStatusChangedMessage(item.path[0]);
                                break;
                            default:
                                console.log("not implemented handler");
                                break;
                        }
                    } else if (item.op == 'add') {
                        sendNewValidatorAdded(item.path[0]);
                    }
                });
            };
            lastState = newState;
            newState = {};
        });
    } catch (e) {
        console.log(e);
    }
});

async function sendJailChangedMessage(address) {
    let jailed = newState[address].jailed ? "jailed. Go back online ASAP!" : "unjailed. Welcome back, Hero!";
    let msg = `Validator *` + newState[address].description.moniker + `* now is ` + jailed;
    let userList = dataService.getUserList();
    userList.forEach(userId => {
        bot.telegram.sendMessage(userId, msg, markup);
    });
}

async function sendDelegationChangedMessage(address) {
    let msg = `Validator ` + newState[address].description.moniker + ` shares changed from: ` +
    parseInt(lastState[address].delegator_shares) / 1000000000 + " GEUL's to *" + parseInt(newState[address].delegator_shares) / 1000000000 + "* GEUL's";
    let userList = dataService.getUserList();
    userList.forEach(userId => {
        bot.telegram.sendMessage(userId, msg, markup);
    });
}

function sendStatusChangedMessage(address) { }

async function sendNewValidatorAdded(address) {
    let msg = `New Hero *` + newState[address].description.moniker + `* with stake *` + parseInt(newState[address].delegator_shares) / 1000000000 + `* GEUL's joined us.\nWelcome to *Cyber* and The Great Web! #fuckgoogle`;
    let userList = dataService.getUserList();
    userList.forEach(userId => {
        bot.telegram.sendMessage(userId, msg, markup);
    });
}

bot.command('start', ctx => {
    dataService.registerUser(ctx);
    let startMsg = `Hi there, humanoids. I'm Cyberadmin Robot which maintains Cyber network. I'm going to send you notifications about network's state and you may also ask me about network stats with /stats anytime`
    ctx.reply(startMsg);
});

bot.command('stats', ctx => {
    let statsMsg;
    try {
        request(config.cybernodeRPC+'/index_stats', function (error, response, data) {
            data = JSON.parse(data).result;
            let jailed = _.countBy(lastState, 'jailed');
            statsMsg = 'Knowledge graph have *' + data.cidsCount + `* objects, connected by *` + data.linksCount + `* cyberlinks.`
            statsMsg += `\nNetwork on block *` + data.height + `*, powered by *` + data.accsCount + `* agents.`
            statsMsg += `\nIn consensus between *` + jailed['false'] + `* validators.`
            request(config.cybernodeRPC+'/status', function (error, response, data) {
                data = JSON.parse(data).result;
                statsMsg += `\nLast block: *` + Math.round(lastBlockTime*100) / 100 + `* seconds.`
                let delay = Math.round((Date.now() / 1000 - lastBlockTimestamp) * 100) / 100;
                if (delay > 10.0) statsMsg += `\nAlert! Last block was: *` + delay + `* seconds ago. @litvintech @mrlp4`
                statsMsg += `\nI'm сyberadmin of *` + data.node_info.network + `* network of *Cyber*`;
                ctx.replyWithMarkdown(statsMsg);
            });
        });
    } catch (e) {
        console.log(e);
    }
});