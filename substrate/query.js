// Copyright 2022 Colorful Notion, Inc.
// This file is part of Polkaholic.

// Polkaholic is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Polkaholic is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with Polkaholic.  If not, see <http://www.gnu.org/licenses/>.

const AssetManager = require("./assetManager");
const paraTool = require("./paraTool");
const ethTool = require("./ethTool");
const mysql = require("mysql2");
const uiTool = require('./uiTool')
const assetAndPriceFeedTTL = 300; // how long the data stays cached
const {
    BigQuery
} = require('@google-cloud/bigquery');

module.exports = class Query extends AssetManager {
    debugLevel = paraTool.debugNoLog;

    contractABIs = false;
    contractABISignatures = {};

    constructor(debugLevel = paraTool.debugNoLog) {
        super()

        if (debugLevel) {
            this.debugLevel = debugLevel;
        }
    }

    async init() {
        await this.assetManagerInit()
        this.contractABIs = await this.getContractABI();
        return (true);
    }

    // this supports reloading of chains/assets/specVersions every 15m
    async autoUpdate(intervalSeconds = 900) {
        while (1) {
            await this.sleep(intervalSeconds * 1000);
            console.log("query autoUpdating...")
            await this.init();
        }
    }
    async checkAPIKey(apikey) {
        let minkey = this.currentMinuteKey();
        let ratekey = `rate:${minkey}`;
        let ratelimit = 300;
        let usage = 0;
        try {
            const [row] = await this.btAPIKeys.row(apikey).get([ratekey, "n"]);
            if (row["n"] && row["n"]["ratelimit"]) {
                let x = row["n"]["ratelimit"];
                ratelimit = parseInt(x[0].value, 10);
            }
            if (row["rate"] && row["rate"][minkey]) {
                let y = row["rate"][minkey];
                if (y.length > 0) {
                    usage = y[0].value;
                }
            }
            //console.log("checkAPIKey", apikey, "usage", usage, "ratelimit", ratelimit);
            if (usage < ratelimit) {
                return ({
                    "success": true
                });
            } else {
                return ({
                    "error": "rate limit exceeded",
                    "code": 429
                });
            }
        } catch (e) {
            if (e.code == 404) {
                //console.log("checkAPIKey 404", apikey)
                return ({
                    "success": true
                });
            } else {
                return ({
                    "error": "general error",
                    "code": 401
                });
            }
        }

    }

    currentMinuteKey() {
        let today = new Date();
        let dd = today.getUTCDate().toString().padStart(2, '0');
        let mm = String(today.getUTCMonth() + 1).padStart(2, '0'); //January is 0!
        let yyyy = today.getUTCFullYear();
        let hr = today.getUTCHours().toString().padStart(2, "0");
        let min = today.getUTCMinutes().toString().padStart(2, "0");
        return `${yyyy}${mm}${dd}-${hr}${min}`;
    }

    async tallyAPIKey(apikey, cnt = 1) {
        // increment "rate" cell
        try {
            let minkey = this.currentMinuteKey();
            let ratekey = `rate:${minkey}`;
            const row = this.btAPIKeys.row(apikey);
            await row.increment(ratekey, cnt);
            return (true);
        } catch (e) {
            console.log(e);
        }
        return (true);
    }


    canonicalizeEmail(e) {
        return e.trim().toLowerCase();
    }

    getPasswordHash(h) {
        let SALT = (process.env.POLKAHOLIC_SALT != undefined) ? process.env.POLKAHOLIC_SALT : "";
        return uiTool.blake2(`${SALT}${h}`)
    }

    create_api_key(email) {
        let ts = Math.floor(Date.now() / 1000)
        let raw = uiTool.blake2(email + ts.toString());
        raw = raw.substring(2, 34);
        return (raw);
    }

    async userExists(email) {
        var sql = `select password from user where email = '${email}' limit 1`;
        let users = await this.poolREADONLY.query(sql);
        return (users.length > 0)
    }

    async getRuntimeExtrinsics(chain) {
        var sql = `select section, method, numStars, numExtrinsics, numExtrinsics30d, numExtrinsics7d from extrinsics where chainID = '${chain.chainID}' order by section, method`;
        let extrinsics = await this.poolREADONLY.query(sql);
        return (extrinsics);
    }

    async getRuntimeEvents(chain) {
        var sql = `select section, method, numStars, numEvents, numEvents30d, numEvents7d from events where chainID = '${chain.chainID}' order by section, method`;
        let events = await this.poolREADONLY.query(sql);
        return events;
    }

    async updateChainAdmin(chainID, chainName, id, ss58Format, asset, symbol, WSEndpoint, WSEndpoint2, WSEndpoint3) {
        prefix = parseInt(prefix, 10);
        let sql = `update chain set chainName = ${mysql.escape(chainName)}, id = ${mysql.escape(id)}, ss58Format = '${ss58Format}', asset = ${mysql.escape(asset)}, symbol = ${mysql.escape(symbol)}, WSEndpoint = ${mysql.escape(WSEndpoint)}, WSEndpoint2 = ${mysql.escape(WSEndpoint2)}, WSEndpoint3 = ${mysql.escape(WSEndpoint3)} where chainID = '${chainID}'`;
        try {
            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            return ({
                success: true
            });
        } catch (e) {
            this.logger.error({
                "op": "query.updateChainAdmin",
                sql,
                err
            });
            return ({
                error: "Could not update chain"
            });
        }
    }

    resetPasswordSig(toMail, ts) {
        let h = ts + toMail + this.POLKAHOLIC_EMAIL_PASSWORD;
        let sig = uiTool.blake2(h);
        return sig;
    }

    async sendResetPasswordLink(toMail) {
        // include nodemailer
        const nodemailer = require('nodemailer');
        // declare vars
        let fromMail = 'info@polkaholic.io';

        let subject = 'Polkaholic.io Password Reset';
        let ts = new Date().getTime().toString();
        let sig = this.resetPasswordSig(toMail, ts);
        let RESETURL = `http://polkaholic.io/resetpassword/${toMail}/${ts}/${sig}`
        let text = `To reset your password on Polkaholic click this link:\r\n${RESETURL}`;

        // auth
        var transporter = nodemailer.createTransport({
            service: 'Godaddy',
            secureConnection: false,
            auth: {
                user: this.POLKAHOLIC_EMAIL_USER,
                pass: this.POLKAHOLIC_EMAIL_PASSWORD
            }
        });

        // email options
        let mailOptions = {
            from: fromMail,
            to: toMail,
            subject: subject,
            text: text
        };

        // send email
        transporter.sendMail(mailOptions, (error, response) => {
            if (error) {
                console.log(error);
            }
        });
    }

    async resetPassword(email, password, ts, sig) {
        let expectedSig = this.resetPasswordSig(email, ts);
        if (sig != expectedSig) return ({
            error: "Could not reset password"
        });

        var passwordHash = this.getPasswordHash(password)
        let sql = `update user set password = '${passwordHash}' where email = ${mysql.escape(email)}`;
        try {
            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            return ({
                success: true
            });
        } catch (e) {
            this.logger.error({
                "op": "query.resetPassword",
                sql,
                err
            });
            return ({
                error: "Could not reset password"
            });
        }
    }

    async followUser(rawFromAddress, rawToAddress) {
        try {
            let fromAddress = paraTool.getPubKey(rawFromAddress)
            let toAddress = paraTool.getPubKey(rawToAddress)
            // check that we aren't following the user already
            // TODO: validate fromAddress + toAddress
            let sql0 = `select isFollowing from follow where fromAddress = '${fromAddress}' and toAddress = '${toAddress}'`
            let isFollowing = await this.pool.query(sql0)
            if (isFollowing.length == 0) {
                var sql = `insert into follow ( fromAddress, toAddress, isFollowing, followDT ) values ('${fromAddress}', '${toAddress}', 1, Now() )`
                var sql2 = `insert into account ( address, numFollowing ) values ('${fromAddress}', 1 ) on duplicate key update numFollowing = numFollowing + 1`
                var sql3 = `insert into account ( address, numFollowers ) values ('${toAddress}', 1 ) on duplicate key update numFollowers = numFollowers + 1`
                this.batchedSQL.push(sql);
                this.batchedSQL.push(sql2);
                this.batchedSQL.push(sql3);
                await this.update_batchedSQL();
                return ({
                    success: true
                });
            } else {
                return ({
                    error: "already following"
                });
            }
        } catch (e) {
            this.logger.error({
                "op": "query.followUser",
                rawFromAddress,
                rawToAddress,
                err
            });
            return ({
                error: "Could not follow user"
            });
        }
    }

    async unfollowUser(rawFromAddress, rawToAddress) {
        try {
            let fromAddress = paraTool.getPubKey(rawFromAddress)
            let toAddress = paraTool.getPubKey(rawToAddress)
            // TODO: validate fromAddress + toAddress
            // check that we are following the user already
            let sql0 = `select isFollowing from follow where fromAddress = '${fromAddress}' and toAddress = '${toAddress}'`
            let isFollowing = await this.pool.query(sql0)
            if (isFollowing.length > 0) {
                // TODO: make this a transaction
                var sql = `delete from follow where fromAddress = '${fromAddress}' and toAddress = '${toAddress}'`
                var sql2 = `update account set numFollowing = numFollowing - 1 where address = '${fromAddress}'`
                var sql3 = `update account set numFollowers = numFollowers - 1 where address = '${toAddress}'`
                this.batchedSQL.push(sql);
                this.batchedSQL.push(sql2);
                this.batchedSQL.push(sql3);
                await this.update_batchedSQL();
                return ({
                    success: true
                });
            } else {
                return ({
                    error: "not following"
                });
            }
        } catch (e) {
            this.logger.error({
                "op": "query.followUser",
                rawFromAddress,
                rawToAddress,
                err
            });

            return ({
                error: "Could not unfollow user"
            });
        }
    }

    async getFollowers(rawToAddress, rawUserAddress = false, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        try {
            let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

            let toAddress = paraTool.getPubKey(rawToAddress)
            var sql = `select fromAddress, 0 as isFollowing from follow where toAddress = '${toAddress}' order by followDT desc limit 500`
            let followers = await this.poolREADONLY.query(sql);
            if (rawUserAddress) {
                let isFollowing = {};
                let userAddress = paraTool.getPubKey(rawUserAddress)

                let sql0 = `select toAddress from follow where fromAddress = '${userAddress}' limit 500`
                let userFollowing = await this.poolREADONLY.query(sql0);
                for (let i = 0; i < userFollowing.length; i++) {
                    let u = userFollowing[i];
                    isFollowing[u.toAddress] = 1;
                }
                for (let i = 0; i < followers.length; i++) {
                    if (decorate) this.decorateAddress(followers[i], "toAddress", decorateAddr, decorateRelated);
                    if (isFollowing[followers[i].toAddress] !== undefined) {
                        followers[i].isFollowing = 1;
                    }
                }
                return (followers);
            }
        } catch (err) {
            this.logger.error({
                "op": "query.getFollowers",
                rawToAddress,
                rawUserAddress,
                err
            });
        }
        return [];
    }

    async getFollowing(rawFromAddress, rawUserAddress = false, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        try {
            let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

            let fromAddress = paraTool.getPubKey(rawFromAddress)
            var sql = `select toAddress, 0 as isFollowing from follow where fromAddress = '${fromAddress}' order by followDT desc limit 500`
            let following = await this.poolREADONLY.query(sql);
            let isFollowing = {};
            if (rawUserAddress) {
                let userAddress = paraTool.getPubKey(rawUserAddress)
                let sql0 = `select toAddress from follow where fromAddress = '${userAddress}' limit 500`
                let userFollowing = await this.poolREADONLY.query(sql0);
                for (let i = 0; i < userFollowing.length; i++) {
                    let u = userFollowing[i];
                    isFollowing[u.toAddress] = 1;
                }
                for (let i = 0; i < following.length; i++) {
                    if (decorate) this.decorateAddress(following[i], "toAddress", decorateAddr, decorateRelated);
                    if (isFollowing[following[i].toAddress] !== undefined) {
                        following[i].isFollowing = 1;
                    }
                }
            }
            return (following);
        } catch (err) {
            console.log(err);
            this.logger.error({
                "op": "query.getFollowers",
                rawFromAddress,
                rawUserAddress,
                err
            });
            return [];
        }
        return [];
    }

    /*
     insert into account ( address, numFollowing ) (select fromAddress, sum(isFollowing) numFollowing from follow group by fromAddress) on duplicate key update numFollowing = values(numFollowing);
     insert into account ( address, numFollowers ) (select toAddress, sum(isFollowing) numFollowers from follow group by toAddress) on duplicate key update numFollowers = values(numFollowers);
    */

    async registerUser(email, password) {
        email = this.canonicalizeEmail(email);
        if (!uiTool.validEmail(email)) {
            return ({
                error: `Invalid email: ${email}`
            });
        }
        if (!uiTool.validPassword(password)) {
            return ({
                error: "Invalid password (must be 6 chars or more)"
            });
        }
        let userAlreadyExists = await this.userExists(email);
        if (userAlreadyExists) {
            return ({
                error: "User already exists."
            });
        }
        var passwordHash = this.getPasswordHash(password)
        try {
            var sql = `insert into user ( email, password, createDT ) values ('${email}', '${passwordHash}', Now() )`
            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            return ({
                success: true
            });
        } catch (e) {
            this.logger.error({
                "op": "query.registerUser",
                email,
                passwordHash,
                err
            });
            return ({
                error: "Could not register user"
            });
        }
    }

    async validateUser(email, password) {
        let passwordHash = this.getPasswordHash(password)
        try {
            var sql = `select password from user where email = '${email}' limit 1`;
            let users = await this.poolREADONLY.query(sql);
            if (users.length == 0) {
                return {
                    error: "Email not found"
                };
            }
            if (users.length == 1 && (users[0].password != passwordHash)) {
                return {
                    error: "Password incorrect"
                };
            }
            return ({
                success: true
            });
        } catch (err) {
            this.logger.error({
                "op": "query.validateUser",
                email,
                passwordHash,
                err
            });
            return ({
                error: "Could not validate your account"
            })
        }
    }

    async updateAPIKeyPlan(email, apikey, planID) {
        // TODO with stripe
        try {
            // update bigtable with new PlanID
            let ratelimit = this.getPlanRateLimit(planID);
            let nrec = {};
            nrec["ratelimit"] = {
                value: JSON.stringify(ratelimit),
                timestamp: new Date()
            };
            let rowsToInsert = [{
                key: apikey,
                data: {
                    n: nrec
                }
            }];
            await this.btAPIKeys.insert(rowsToInsert);

            var sql = `update apikey set planID = '${planID}' where email = '${email}' and apikey = '${apikey}'`;
            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            return (true);
        } catch (err) {
            this.logger.error({
                "op": "query.updateAPIKeyPlan",
                email,
                apikey,
                err
            });
            return (false);
        }
    }

    getAPIKeyPlan(loggedInEmail, apikey) {}
    async getAPIKeys(email) {
        var sql = `select apikey, createDT, planID from apikey where email = '${email}' and deleted = 0 limit 100`;
        try {
            let apikeys = await this.poolREADONLY.query(sql);
            return (apikeys);
        } catch (e) {
            this.logger.error({
                "op": "query.getAPIKeys",
                email,
                apikey,
                err
            });
            return (false);
        }
    }

    // # of request allowed per minute
    getPlanRateLimit(planID) {
        switch (planID) {
            case 1:
                return (1200); // 20 QPS
            case 2:
                return (6000); // 100 QPS
            case 3:
                return (30000); // 500 QPS
            default:
                return (300); // 5 QPS
        }
    }

    getPlans() {
        return [{
            name: "Developer",
            monthlyUSD: 0,
            minuteLimit: this.getPlanRateLimit(0)
        }, {
            name: "Lite",
            monthlyUSD: 199,
            minuteLimit: this.getPlanRateLimit(1)
        }, {
            name: "Pro",
            monthlyUSD: 399,
            minuteLimit: this.getPlanRateLimit(2)
        }, {
            name: "Enterprise",
            monthlyUSD: 1999,
            minuteLimit: this.getPlanRateLimit(3)
        }];
    }

    async createAPIKey(email, planID = 0) {
        let apikey = this.create_api_key(email)
        var sql = `insert into apikey (email, apikey, createDT) values ('${email}', '${apikey}', Now())`;
        try {
            // update bigtable
            let ratelimit = this.getPlanRateLimit(planID);
            console.log(apikey, planID, ratelimit);
            let nrec = {};
            nrec["ratelimit"] = {
                value: JSON.stringify(ratelimit),
                timestamp: new Date()
            };
            let rowsToInsert = [{
                key: apikey,
                data: {
                    n: nrec
                }
            }];


            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            await this.btAPIKeys.insert(rowsToInsert);
            return ({
                success: true,
                apikey: apikey
            })
        } catch (err) {
            this.logger.error({
                "op": "query.createAPIKey",
                email,
                sql,
                err
            });
            return ({
                error: "Could not create API Key"
            });
        }
    }

    async deleteAPIKey(email, apikey) {
        var sql = `update apikey set deleted = 1, deleteDT = Now() where email = '${email}' and apikey = '${apikey}'`;
        try {
            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            return ({
                success: true
            })
        } catch (e) {
            this.logger.error({
                "op": "query.deleteAPIKey",
                email,
                sql,
                err
            });
            return ({
                error: "Could not delete API Key"
            });
        }
    }

    async search_address(addr) {
        let res = [];
        try {
            let [tblName, tblRealtime] = this.get_btTableRealtime()
            // TODO: use getRow?
            let [rows] = await tblRealtime.getRows({
                keys: [addr]
            });
            rows.forEach((row) => {
                let rowData = row.data;
                res.push({
                    link: "/account/" + addr,
                    text: addr,
                    description: "Address"
                })
            });
        } catch (err) {
            if (err.code == 404) {
                return res;
            } else {
                this.logger.error({
                    "op": "query.search_address",
                    addr,
                    err
                });
            }
        }
        return res;
    }

    getChainInfo(chainID = paraTool.chainIDPolkadot) {
        // TODO: fill in stub -- use ChainID to get from data structure created in init
        return this.getChainFullInfo(chainID)
    }

    redirect_search_block(hash, blockcells, res = []) {
        let cell = blockcells[0];
        let feed = JSON.parse(cell.value);
        if (feed) {
            let chainID = feed.chainID;
            let blockNumber = feed.blockNumber;
            if (blockNumber) {
                // send users to eg /block/0/9963670?blockhash=0xcf10b0c43f5c87de7cb9b3c0be6187097bd936bde19bd937516482ac01a8d46f
                res.push({
                    link: `/block/${chainID}/${blockNumber}?blockhash=${hash}`,
                    text: `chain: ${chainID} blockNumber: ${blockNumber} hash: ${hash}`,
                    description: this.getChainName(chainID) + " Block " + blockNumber + " : " + hash
                })
            }
        }
    }

    check_block_hash(hash, blockcells, res) {
        let cell = blockcells[0];
        let feed = JSON.parse(cell.value);
        if (feed) {
            let chainID = feed.chainID;
            let blockNumber = feed.blockNumber;
            let blockType = 'substrate'
            if (feed.blockType != undefined) {
                blockType = feed.blockType
            }
            if (blockNumber) {
                res.hash = hash
                res.chainID = chainID
                res.blockNumber = blockNumber
                if (blockType == 'evm') {
                    res.hashType = 'evmBlockHash'
                } else if (blockType == 'substrate') {
                    res.hashType = 'substrateBlockHash'
                }
            }
        }
    }

    check_tx_hash(hash, txcells, res) {
        let cell = txcells[0]; // TODO: how do you support edge case of multiple distinct txhashes - can we use versions https://github.com/paritytech/polkadot/issues/231
        let feed = JSON.parse(cell.value);
        if (feed) {
            let chainID = feed.chainID;
            let blockNumber = (feed.blockNumber != undefined) ? feed.blockNumber : null;
            let hashType = (feed.extrinsicHash != undefined) ? 'extrinsicHash' : 'transactionHash'
            res.hash = hash
            res.chainID = chainID
            res.blockNumber = blockNumber
            res.hashType = hashType
        }
    }

    redirect_search_tx(hash, txcells, res = []) {
        let cell = txcells[0]; // TODO: how do you support edge case of multiple distinct txhashes - can we use versions https://github.com/paritytech/polkadot/issues/231
        let feed = JSON.parse(cell.value);
        if (feed) {
            let chainID = feed.chainID;
            let blockNumber = feed.blockNumber;
            let addr = feed.addr;
            res.push({
                link: "/tx/" + hash,
                text: `chain: ${chainID} blockNumber: ${blockNumber} address: ${addr}`,
                description: "tx"
            })
        }
    }

    async search_hash(hash) {
        let res = [];
        let families = ['feed', 'feedunfinalized', 'feedevmunfinalized', 'feedpending'] // 3 columnfamily
        try {
            let [rows] = await this.btHashes.getRows({
                keys: [hash]
            });
            rows.forEach((row) => {
                let rowData = row.data;
                //priority: use feed then feedunfinalized/feedevmunfinalized
                let blockcells = false;
                let txcells = false;
                let data = false

                if (rowData["feed"]) {
                    // finalized
                    data = rowData["feed"]
                } else if (rowData["feedunfinalized"]) {
                    data = rowData["feedunfinalized"]
                } else if (rowData["feedevmunfinalized"]) {
                    data = rowData["feedevmunfinalized"]
                } else if (rowData["feedpending"]) {
                    data = rowData["feedpending"]
                }
                if (data) {
                    if (data["block"]) {
                        blockcells = data["block"]
                        this.redirect_search_block(hash, blockcells, res)
                    } else if (data["tx"]) {
                        txcells = data["tx"]
                        this.redirect_search_tx(hash, txcells, res)
                    }
                }
            });
        } catch (err) {
            if (err.code == 404) {
                return res;
            } else {
                this.logger.error({
                    "op": "query.search_hash",
                    hash,
                    err
                });
            }
        }
        return res;
    }

    async lookupHash(hash) {
        let res = {
            hash: hash,
            hashType: 'NotFound', //substrateBlockHash/evmBlockHash, extrinsicHash, transactionHash
            status: 'NotFound',
            chainID: null,
            blockNumber: null,
        };
        let families = ['feed', 'feedunfinalized', 'feedevmunfinalized', 'feedpending', 'feedxcmdest'] // 3 columnfamily
        try {
            // TODO: use getRow
            let [rows] = await this.btHashes.getRows({
                keys: [hash]
            });
            for (let i = 0; i < rows.length; i++) {
                let row = rows[i];
                let rowData = row.data;
                //priority: use feed then feedunfinalized/feedevmunfinalized
                let blockcells = false;
                let txcells = false;
                let data = false

                if (rowData["feedxcmdest"]) {
                    data = rowData["feedxcmdest"]
                    res.status = 'finalizeddest'
                } else if (rowData["feed"]) {
                    // finalized
                    data = rowData["feed"]
                    res.status = 'finalized'

                    // **** SPECIAL CASE: EVM txhash ..
                    try {
                        if (data.tx != undefined && data.tx[0]) {
                            const cell = data.tx[0];
                            let c = JSON.parse(cell.value);
                            if (c.gasLimit != undefined) {
                                console.log("CELL", c);
                                if (this.is_evm_xcmtransfer_input(c.input)) {
                                    let substrateTXHash = c.substrate.extrinsicHash;
                                    let substratetx = await this.getTransaction(substrateTXHash);
                                    if (substratetx.xcmdest != undefined) {
                                        res.status = "finalizeddest";
                                        // bring this in!
                                        res.xcmdest = substratetx.xcmdest;
                                    }
                                }
                            }
                        }
                    } catch (errS) {
                        console.log(errS);
                    }
                } else if (rowData["feedunfinalized"]) {
                    data = rowData["feedunfinalized"]
                    res.status = 'unfinalized'
                } else if (rowData["feedevmunfinalized"]) {
                    data = rowData["feedevmunfinalized"]
                    res.status = 'unfinalized'
                } else if (rowData["feedpending"]) {
                    data = rowData["feedpending"]
                    res.status = 'pending'
                }
                if (data) {
                    if (data["block"]) {
                        blockcells = data["block"]
                        this.check_block_hash(hash, blockcells, res)
                    } else if (data["tx"]) {
                        txcells = data["tx"]
                        this.check_tx_hash(hash, txcells, res)
                    }
                }
            }
        } catch (err) {
            if (err.code == 404) {
                return res;
            } else {
                this.logger.error({
                    "op": "query.lookupHashsearch_hash",
                    hash,
                    err
                });
            }
        }
        return res;
    }

    async search_blocks(bn) {
        let chains = await this.getChains();
        let res = [];
        for (var i = 0; i < chains.length; i++) {
            if (bn < chains[i].blocksCovered) {
                res.push({
                    link: "/block/" + chains[i].chainID + "/" + bn,
                    text: chains[i].chainName + " Block " + bn.toString(),
                    description: "Block"
                });
            }
        }
        return res;
    }

    async getSearchResults(search) {
        if (search.length > 45 && search.length < 53) {
            let addr = paraTool.getPubKey(search);
            return await this.search_address(addr);
        } else if (search.length == 66) {
            var tasks = [this.search_address(search), this.search_hash(search)];
            var results = await Promise.all(tasks);
            var out = results.flat(2);
            return out;
        } else if (search.length < 12) {
            let bn = parseInt(search, 10);
            if (bn > 0) {
                return await this.search_blocks(bn);
            }
        } else if (search.length == 42) {
            // evm address
            var tasks = [this.search_address(search.toLowerCase())];
            var results = await Promise.all(tasks);
            var out = results.flat(1);
            return out;
        }
        return [];
    }

    async getChainSymbols(chainID_or_chainName) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) return [];
        try {
            let sql = `select distinct symbol from asset where chainID = 2000 and assetType = 'Token' order by symbol`;
            let symbols = await this.poolREADONLY.query(sql);
            return symbols;
        } catch (err) {
            this.logger.error({
                "op": "query.getChainSymbols",
                chainID_or_chainName,
                err
            });
        }
    }

    async getChain(chainID_or_chainName) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) {
            throw new paraTool.NotFoundError(`Chain not found: ${chainID_or_chainName}`)
            return (false);
        }
        try {
            let chains = await this.poolREADONLY.query(`select id, chainID, chainName, blocksCovered, blocksFinalized, symbol, UNIX_TIMESTAMP(lastCrawlDT) as lastCrawlTS, UNIX_TIMESTAMP(lastFinalizedDT) as lastFinalizedTS, iconUrl, crawling, crawlingStatus, numTraces, WSEndpoint, WSEndpoint2, WSEndpoint3, relayChain, paraID, ss58Format,
            numHolders, totalIssuance,
            numExtrinsics, numExtrinsics7d, numExtrinsics30d,
            numSignedExtrinsics, numSignedExtrinsics7d, numSignedExtrinsics30d,
            numTransfers, numTransfers7d, numTransfers30d,
            numEvents, numEvents7d, numEvents30d,
            valueTransfersUSD, valueTransfersUSD7d, valueTransfersUSD30d,
            numXCMTransferIncoming, numXCMTransferIncoming7d, numXCMTransferIncoming30d,
            numXCMTransferOutgoing, numXCMTransferOutgoing7d, numXCMTransferOutgoing30d,
            valXCMTransferIncomingUSD, valXCMTransferIncomingUSD7d, valXCMTransferIncomingUSD30d,
            valXCMTransferOutgoingUSD, valXCMTransferOutgoingUSD7d, valXCMTransferOutgoingUSD30d,
            subscanURL, dappURL, githubURL, parachainsURL, isEVM from chain where chainID = ${chainID}`)
            if (chains.length == 1) {
                let chainInfo = chains[0]
                if (chainInfo.isEVM) {
                    let evmChains = await this.poolREADONLY.query(`select
                  numTransactionsEVM, numTransactionsEVM7d, numTransactionsEVM30d,
                  numReceiptsEVM, numReceiptsEVM7d, numReceiptsEVM30d,
                  floor(gasUsed / (numEVMBlocks+1)) as gasUsed,
                  floor(gasUsed7d / (numEVMBlocks7d+1)) as gasUsed7d,
                  floor(gasUsed30d / (numEVMBlocks30d+1)) as gasUsed30d,
                  floor(gasLimit / (numEVMBlocks+1)) as gasLimit,
                  floor(gasLimit7d / (numEVMBlocks7d+1)) as gasLimit7d,
                  floor(gasLimit30d / (numEVMBlocks30d+1)) as gasLimit30d
                  from chain where chainID = ${chainID} and isEVM = 1`);
                    if (evmChains.length == 1) {
                        let evmChainInfo = evmChains[0]
                        for (const k of Object.keys(evmChainInfo)) {
                            let v = evmChainInfo[k]
                            chainInfo[k] = paraTool.dechexToInt(v)
                        }
                    }
                }
                return chainInfo
            }
        } catch (err) {
            this.logger.error({
                "op": "query.getChain",
                chainID,
                id,
                err
            });
        }
        return (false);
    }

    trimquote(s) {
        if (s.length >= 2 && (s.substring(0, 1) == '"') && (s.substring(s.length - 1, s.length))) {
            return s.substring(1, s.length - 1);
        }
        return s;
    }

    async getXCMTransfers(filters = {}, limit = 1000, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {

        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let chainList = filters.chainList ? filters.chainList : [];
        let blockNumber = filters.blockNumber ? parseInt(filters.blockNumber, 10) : null;
        let address = filters.address ? filters.address : null;
        let out = [];
        try {
            let w = address ? `and fromAddress = '${address}'` : "";
            if (blockNumber) {
                w += ` and blockNumber = '${parseInt(blockNumber, 10)}'`
            }
            let chainListFilter = "";
            if (chainList.length > 0) {
                chainListFilter = ` and ( chainID in ( ${chainList.join(",")} ) or chainIDDest = ${chainList.join(",")} )`
            }
            let xcmtransfers = await this.poolREADONLY.query(`select extrinsicHash, extrinsicID, chainID, chainIDDest, blockNumber, fromAddress, destAddress, sectionMethod, asset, rawAsset, nativeAssetChain, blockNumberDest, sourceTS, destTS, amountSent, amountReceived, status, relayChain, incomplete, relayChain from xcmtransfer where length(asset) > 3 ${w} ${chainListFilter} order by sourceTS desc limit ${limit}`);
            for (let i = 0; i < xcmtransfers.length; i++) {
                let x = xcmtransfers[i];
                x.asset = this.trimquote(x.asset); // temporary hack
                if (x.asset.includes("Token")) {
                    let decimals = false;
                    let targetChainID = x.chainID // the chainID to use for price lookup
                    let targetAsset = x.rawAsset // the asset to use for price lookup
                    let defaultAsset = x.asset // the "default" asset (human readable?)

                    if (x.nativeAssetChain != undefined) {
                        let [nativeAsset, nativeChainID] = paraTool.parseAssetChain(x.nativeAssetChain)
                        targetAsset = nativeAsset
                        targetChainID = nativeChainID
                        defaultAsset = nativeAsset // use nativeAsset as defaultAsset (if set)
                    }

                    let rawassetChain = paraTool.makeAssetChain(targetAsset, targetChainID);
                    if (this.assetInfo[rawassetChain] && this.assetInfo[rawassetChain].decimals != undefined) {
                        decimals = this.assetInfo[rawassetChain].decimals;
                    } else {
                        //missing
                        let [nativeChainID, isFound] = await this.getNativeAssetChainID(defaultAsset)
                        if (isFound) {
                            targetChainID = nativeChainID
                            rawassetChain = paraTool.makeAssetChain(targetAsset, targetChainID);
                        }
                        if (this.assetInfo[rawassetChain] && this.assetInfo[rawassetChain].decimals != undefined) {
                            decimals = this.assetInfo[rawassetChain].decimals;
                        }
                    }

                    if (this.assetInfo[rawassetChain]) {
                        //let decimals = this.assetInfo[assetChain].decimals;
                        if (decimals !== false) {
                            x.amountSent = x.amountSent / 10 ** decimals;
                            x.amountReceived = x.amountReceived / 10 ** decimals;
                            if (decorateUSD) {
                                let [amountSentUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(x.amountSent, targetAsset, targetChainID, x.sourceTS);
                                x.amountSentUSD = amountSentUSD;
                                x.priceUSD = priceUSD;
                                x.priceUSDCurrent = priceUSDCurrent;
                                x.amountReceivedUSD = x.amountReceived * priceUSD;
                            }
                            x.chainName = this.getChainName(x.chainID);
                            [x.chainID, x.id] = this.convertChainID(x.chainID)
                            if (x.chainIDDest != undefined) {
                                [x.chainIDDest, x.idDest] = this.convertChainID(x.chainIDDest)
                                x.chainDestName = this.getChainName(x.chainIDDest);
                                let sectionPieces = x.sectionMethod.split(':')
                                let r = {
                                    extrinsicHash: x.extrinsicHash,
                                    extrinsicID: x.extrinsicID,
                                    incomplete: x.incomplete,
                                    status: x.status,

                                    section: sectionPieces[0],
                                    method: sectionPieces[1],

                                    // relayChain
                                    relayChain: x.relayChain,

                                    //source section
                                    fromAddress: x.fromAddress,
                                    id: x.id,
                                    chainID: x.chainID,
                                    chainName: x.chainName,
                                    blockNumber: x.blockNumber,
                                    sourceTS: x.sourceTS,

                                    //dest section
                                    destAddress: x.destAddress,
                                    idDest: x.idDest,
                                    chainIDDest: x.chainIDDest,
                                    chainDestName: x.chainDestName,
                                    blockNumberDest: x.blockNumberDest,
                                    destTS: x.destTS,

                                    asset: defaultAsset, //this is default asset (somewhat human-readable)
                                    rawAsset: x.rawAsset, //this is the rawAsset
                                    amountSent: x.amountSent,
                                    amountSentUSD: x.amountSentUSD,
                                    amountReceived: x.amountReceived,
                                    amountReceivedUSD: x.amountReceivedUSD,
                                    priceUSD: x.priceUSD,
                                    priceUSDCurrent: x.priceUSDCurrent,
                                }
                                if (decorate) {
                                    this.decorateAddress(r, "fromAddress", decorateAddr, decorateRelated)
                                    this.decorateAddress(r, "destAddress", decorateAddr, decorateRelated)
                                }
                                out.push(this.clean_extrinsic_object(r));
                            } else {
                                console.log("getXCMTransfers: cannot find decimals:" + x.chainIDDest);
                            }
                            //out.push(this.clean_extrinsic_object(r));
                        } else {
                            console.log("getXCMTransfers: cannot find decimals:" + rawassetChain);
                        }
                    } else {
                        console.log("getXCMTransfers: cannot find assetChain: " + rawassetChain);
                    }
                }
            }
        } catch (err) {
            console.log(`getXCMTransfers err`, err.toString())
            this.logger.error({
                "op": "query.getXCMTransfers",
                address,
                err
            });
        }

        return out;
    }

    async getHashStatus(hash) {
        // 'notFound', 'pending', 'unfinalized', 'finalized'
        let res = {
            hashType: 'unknown',
            status: 'notFound'
        }
        let families = ['feed', 'feedunfinalized', 'feedevmunfinalized', 'feedpending', "feedxcmdest"] // 3 columnfamily
        try {
            let [rows] = await this.btHashes.getRows({
                keys: [hash]
            });
            rows.forEach((row) => {
                let rowData = row.data;
                //priority: use feed then feedunfinalized/feedevmunfinalized
                let data = false;
                if (rowData["feedxcmdest"]) {
                    data = rowData["feedxcmdest"]
                    res.status = 'finalizeddest'
                } else if (rowData["feed"]) {
                    // finalized
                    data = rowData["feed"]
                    res.status = 'finalized'
                } else if (rowData["feedunfinalized"]) {
                    data = rowData["feedunfinalized"]
                    res.status = 'unfinalized'
                } else if (rowData["feedevmunfinalized"]) {
                    data = rowData["feedevmunfinalized"]
                    res.status = 'unfinalized'
                } else if (rowData["feedpending"]) {
                    data = rowData["feedpending"]
                    res.status = 'pending'
                }
                if (data) {
                    if (data["tx"]) {
                        res.hashType = 'tx'
                    } else if (data["block"]) {
                        res.hashType = 'block'
                    }
                }
            });
        } catch (err) {
            this.logger.error({
                "op": "query.getHashStatus",
                hash,
                err
            });
        }
        return res;
    }

    getAssetSymbol(asset) {
        try {
            if (typeof asset == "string") {
                let a = JSON.parse(asset)
                if (a.Token) return (a.Token);
                return (false);
            }
            if (asset && asset.Token) {
                if (a.Token) return (a.Token);
                return (false);
            }
        } catch (err) {
            this.logger.error({
                "op": "query.getAssetSymbol",
                asset,
                err
            });

        }
        return (false);
    }

    is_evm_xcmtransfer_input(inp) {
        return (inp.includes("0xb38c60fa") || inp.includes("0xb9f813ff"));
    }

    async getTransaction(txHash, decorate = true, decorateExtra = ["usd", "address", "related", "data"]) {
        //console.log(`getTransaction txHash=${txHash}, decorate=${decorate}, decorateExtra=${decorateExtra}`)
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        //console.log(`getTransaction txHash=${txHash} decorateData=${decorateData} decorateAddr=${decorateAddr} decorateUSD=${decorateUSD} decorateRelated=${decorateRelated}`)
        const filter = {
            column: {
                cellLimit: 1
            },
        };
        if (!this.validAddress(txHash)) {
            throw new paraTool.InvalidError(`Invalid Extrinsic Hash: ${txHash}`)
        }
        try {
            const [row] = await this.btHashes.row(txHash).get({
                filter
            });
            let rowData = row.data;
            let feedData = false
            let feedTX = false
            let feedXCMDestData = false
            let status = ""
            let isPending = false
            if (rowData["feed"]) {
                feedData = rowData["feed"]
                status = "finalized"
            } else if (rowData["feedunfinalized"]) {
                feedData = rowData["feedunfinalized"]
                status = "unfinalized"
            } else if (rowData["feedevmunfinalized"]) {
                feedData = rowData["feedevmunfinalized"]
                status = "unfinalized"
            } else if (rowData["feedpending"]) {
                feedData = rowData["feedpending"]
                status = "pending"
                isPending = true
            }
            if (feedData && feedData["tx"]) {
                feedTX = feedData["tx"]
            }
            if (rowData["feedxcmdest"]) {
                feedXCMDestData = rowData["feedxcmdest"]
                status = "finalizeddest"
            }
            if (feedTX) {
                const cell = feedTX[0];
                let c = JSON.parse(cell.value);
                if (!paraTool.auditHashesTx(c)) {
                    console.log(`Audit Failed`, txHash)
                }
                if (c.gasLimit) {
                    // this is an EVM tx
                    let assetChain = paraTool.makeAssetChain(c.to.toLowerCase(), c.chainID);
                    if (this.assetInfo[assetChain]) {
                        c.assetInfo = this.assetInfo[assetChain];
                    }
                    c.chainName = this.getChainName(c.chainID)
                    let chainAsset = this.getChainAsset(c.chainID)
                    let cTimestamp = (isPending) ? Math.floor(Date.now() / 1000) : c.timestamp
                    if (isPending) {
                        c.timestamp = cTimestamp
                    }
                    let cFee = (isPending) ? 0 : c.fee
                    //await this.decorateUSD(c, "value", chainAsset, c.chainID, cTimestamp, decorateUSD)
                    if (decorateUSD) {
                        let [valueUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(c.value, chainAsset, c.chainID, cTimestamp);
                        c.valueUSD = valueUSD;
                        c.priceUSD = priceUSD;
                        c.priceUSDCurrent = priceUSDCurrent;
                    }

                    c.symbol = this.getChainSymbol(c.chainID);
                    if (!isPending && decorateUSD) {
                        c.feeUSD = c.fee * c.priceUSD;
                    }

                    c.result = c.status // this is success/fail indicator of the evm tx
                    c.status = status // finalized/unfinalized
                    // decorate transfers
                    if (c.transfers !== undefined && c.transfers.length > 0) {
                        for (let i = 0; i < c.transfers.length; i++) {
                            let t = c.transfers[i];
                            let tokenAsset = t.tokenAddress.toLowerCase();
                            let tokenAssetChain = paraTool.makeAssetChain(tokenAsset, c.chainID);
                            if (this.assetInfo[tokenAssetChain]) {
                                t.assetInfo = this.assetInfo[tokenAssetChain];
                                if (t.assetInfo.decimals !== false) {
                                    t.value = t.value / 10 ** t.assetInfo.decimals;
                                    //await this.decorateUSD(t, "value", tokenAsset, c.chainID, cTimestamp, decorateUSD)
                                    if (decorateUSD) {
                                        let [valueUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(t.value, tokenAsset, c.chainID, cTimestamp);
                                        t.valueUSD = valueUSD;
                                        t.priceUSD = priceUSD;
                                        t.priceUSDCurrent = priceUSDCurrent;
                                    }
                                }
                            }
                        }
                    }
                    if (this.is_evm_xcmtransfer_input(c.input) && c.substrate != undefined) {
                        //  fetch substrate extrinsicHash
                        try {
                            let substratetx = await this.getTransaction(c.substrate.extrinsicHash);
                            console.log("FETCH XCMTRANSFER", substratetx);
                            if (substratetx.xcmdest != undefined) {
                                c.xcmdest = substratetx.xcmdest;
                                console.log("SET XCMTDEST", c.xcmdest);
                            }
                        } catch (errS) {
                            console.log("FETCH XCMTRANSFER ERR", errS);


                        }
                    }
                    return c;
                }

                //c.params = JSON.stringify(c.params)
                let d = await this.decorateExtrinsic(c, c.chainID, status, decorate, decorateExtra)

                if (!isPending) {
                    //pending does not have event, fee, specVersion, blockNumber
                    let dEvents = []
                    for (const evt of d.events) {
                        let dEvent = await this.decorateEvent(evt, d.chainID, d.ts, decorate, decorateExtra)
                        dEvents.push(dEvent)
                    }
                    d.events = dEvents
                    //await this.decorateFee(d, d.chainID, decorateUSD)
                    d.specVersion = this.getSpecVersionForBlockNumber(d.chainID, d.blockNumber);
                }
                //d.chainName = this.getChainName(d.chainID)
                //[d.id, d.chainID] = this.convertChainID(d.chainID)
                //d.status = status;
                try {
                    if (feedXCMDestData) {
                        for (const extrinsicHashEventID of Object.keys(feedXCMDestData)) {
                            const cell = feedXCMDestData[extrinsicHashEventID][0];
                            let xcm = JSON.parse(cell.value);
                            xcm.chainIDName = this.getChainName(xcm.chainID);
                            xcm.chainIDDestName = this.getChainName(xcm.chainIDDest);
                            let chainIDDestInfo = this.chainInfos[xcm.chainIDDest]
                            if (xcm.chainIDDest != undefined && chainIDDestInfo != undefined && chainIDDestInfo.ss58Format != undefined) {
                                if (xcm.destAddress != undefined) {
                                    if (xcm.destAddress.length == 42) xcm.destAddress = xcm.destAddress
                                    if (xcm.destAddress.length == 66) xcm.destAddress = paraTool.getAddress(xcm.destAddress, chainIDDestInfo.ss58Format)
                                } else if (xcm.fromAddress != undefined) {
                                    if (xcm.fromAddress.length == 42) xcm.destAddress = xcm.fromAddress
                                    if (xcm.fromAddress.length == 66) xcm.destAddress = paraTool.getAddress(xcm.fromAddress, chainIDDestInfo.ss58Format)
                                }
                            }
                            if (d.signer != undefined) {
                                xcm.fromAddress = d.signer
                            }
                            let decimals = this.getAssetDecimal(xcm.asset, xcm.chainID)
                            if (decimals === false) {
                                decimals = this.getAssetDecimal(xcm.asset, xcm.chainIDDest)
                            }
                            if (decimals !== false) {
                                xcm.amountSent = xcm.amountSent / 10 ** decimals;
                                xcm.amountReceived = xcm.amountReceived / 10 ** decimals;
                                xcm.fee = xcm.amountSent - xcm.amountReceived
                                /*await this.decorateUSD(xcm, "amountSent", xcm.asset, xcm.chainID, xcm.destTS, decorateUSD)
                                if (decorateUSD){
                                  xcm.amountReceivedUSD = xcm.priceUSD * xcm.amountReceived;
                                }
                                */
                                if (decorateUSD) {
                                    let [amountSentUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(xcm.amountSent, xcm.asset, xcm.chainID, xcm.destTS);
                                    xcm.amountSentUSD = amountSentUSD;
                                    xcm.amountReceivedUSD = priceUSD * xcm.amountReceived;
                                    xcm.feeUSD = priceUSD * xcm.fee
                                    xcm.priceUSD = priceUSD;
                                    xcm.priceUSDCurrent = priceUSDCurrent;
                                }
                                xcm.symbol = this.getAssetSymbol(xcm.asset);
                            }
                            //console.log("XCM", xcm);
                            d.xcmdest = xcm;
                            /*
                            {
                              chainID: 8,
                              chainIDDest: 2,
                              blockNumberDest: 12166647,
                              asset: '{"Token":"KSM"}',
                              amountSent: 3.077995000487,
                              amountReceived: 3.077888333827,
                              fromAddress: '0xc4961c3e6d56ab429c5adbf0b1ae16e7388406e7796e1f9113ef734fb7b7b31e',
                              extrinsicHash: '0xea3edcd77feff932390f114bee12fa794cbcbf71ef98a76002758f429ecef31c',
                              extrinsicID: '1739775-2',
                              eventID: '2-12166647-1-14',
                              sourceTS: 1649440375,
                              destTS: 1649440386,
                              chainIDName: 'Karura',
                              chainIDDestName: 'Kusama',
                              amountSentUSD: 614.0353786371526,
                              priceUSD: 199.492,
                              amountReceivedUSD: 614.0140994918158
                            }
                            */
                            break;
                        }
                    }
                } catch (err) {
                    this.logger.warn({
                        "op": "query.getTransaction",
                        txHash,
                        err
                    });
                }

                return d;
            }

        } catch (err) {
            if (err.code == 404) {
                throw new paraTool.NotFoundError(`Transaction not found: ${txHash}`)
            } else {
                this.logger.error({
                    "op": "query.getTransaction",
                    txHash,
                    err
                });
            }
        }
        return (false);
    }

    async getAssetQuery(assetChain, queryType = "pricefeed", homeAddress = false, querylimit = 3000) {
        switch (queryType) {
            case "pricefeed":
                if (querylimit > 3000) querylimit = 3000
                return await this.getAssetPriceFeed(assetChain, querylimit)
            case "holders":
                if (querylimit > 3000) querylimit = 1000
                return await this.getAssetHolders(assetChain, querylimit)
            case "related":
                if (querylimit > 3000) querylimit = 100
                return await this.getAssetsRelated(assetChain, homeAddress = false, querylimit)
            default:
                return false;
                break;
        }
    }

    async getAssetPriceFeed(assetChain, limit = 3000) {
        if (this.assetInfo[assetChain] == undefined) {
            throw new paraTool.InvalidError(`Invalid asset: ${assetChain}`)
        }
        try {
            let [asset, chainID] = paraTool.parseAssetChain(assetChain)
            let assetInfo = this.assetInfo[assetChain];
            let w = ` and chainID = '${chainID}'`
            let sql = `select indexTS, priceUSD from assetlog where asset = '${asset}' ${w} and indexTS >= UNIX_TIMESTAMP( date_sub(Now(), INTERVAL 90 DAY ) ) order by indexTS  limit ${limit}`
            let assetlog = await this.poolREADONLY.query(sql);
            if (assetlog.length > 0) {
                let results = [];
                for (let i = 0; i < assetlog.length; i++) {
                    let a = assetlog[i];
                    if (a.priceUSD > 0) {
                        let b = [a.indexTS * 1000, a.priceUSD]
                        results.push(b);
                    } else {
                        let [_, priceUSD, priceUSDCurrent] = await this.computeUSD(1.0, asset, chainID, a.indexTS);
                        if (!priceUSD) {
                            priceUSD = 0;
                        }
                        results.push([a.indexTS * 1000, priceUSD, priceUSDCurrent]);
                    }
                }
                return (results);
            }
            if (assetInfo !== undefined && assetInfo.priceUSDpaths !== undefined) {
                let priceUSDpaths = assetInfo.priceUSDpaths;
                let out = [];
                let priceUSDpath = assetInfo.priceUSDpaths[0];
                let currentTS = this.currentTS();
                let startTS = currentTS - 3600 * 24 * 90;
                for (let ts = startTS; ts < currentTS; ts += 3600) {
                    let v = 1.0;
                    let succ = true;
                    for (let j = priceUSDpath.length - 1; j > 0; j--) {
                        let r = priceUSDpath[j];
                        let dexrec = await this.getDexRec(r.route, chainID, ts);
                        if (dexrec) {
                            let s = parseInt(r.s, 10);
                            if (s == 1) {
                                v *= dexrec.close;
                            } else {
                                v /= dexrec.close;
                            }
                        } else {
                            succ = false;
                            console.log("getAssetPriceFeed - MISSING route", r.route);
                        }
                    }
                    if (succ) {
                        out.push([ts * 1000, v])
                    }
                }
                return (out);
            }
        } catch (err) {
            this.logger.error({
                "op": "query.getAssetPriceFeed",
                assetChain,
                err
            });
        }
        return ([]);
    }

    async getAssetPairOHLCV(assetChain, limit = 10000) {
        try {
            let [asset, chainID] = paraTool.parseAssetChain(assetChain)
            let sql = `select indexTS, open, close, low, high, token0Volume, token1Volume, issuance from assetlog where asset = '${asset}' and chainID = '${chainID}' and indexTS >= UNIX_TIMESTAMP(date_sub(Now(), interval 180 day)) order by indexTS desc limit ${limit}`
            let data = await this.poolREADONLY.query(sql);
            let parsedAsset = JSON.parse(asset);
            let parsedToken0 = parsedAsset[0];
            let parsedToken1 = parsedAsset[1];
            let token0 = JSON.stringify(parsedAsset[0]);
            let token1 = JSON.stringify(parsedAsset[1]);

            let ts = this.currentTS();
            let out = [];
            for (let i = 0; i < data.length; i++) {
                let d = data[i];
                let ts = data[i].indexTS;
                let volumeUSD = 0;
                if (d.open < 10000) {
                    try {
                        let token0Volume = parseFloat(d.token0Volume);
                        let token1Volume = parseFloat(d.token1Volume);
                        let [_, token0USD, token0USDCurrent] = await this.computeUSD(1.0, token0, chainID, ts);
                        let [__, token1USD, token1USDCurrent] = await this.computeUSD(1.0, token1, chainID, ts);
                        // this is the amount of swap volume
                        volumeUSD = token0Volume * token0USD + token1Volume * token1USD;
                    } catch (err) {
                        console.log("computevolumeUSD", token0, token1, err);
                    }
                    out.push([d.indexTS * 1000, d.open, d.close, d.low, d.high, volumeUSD]);
                }
            }
            return out;
        } catch (err) {
            this.logger.error({
                "op": "query.getAssetPairOHLCV",
                assetChain,
                err
            });
        }
    }


    async getAssetHolders(assetChain, limit = 1000) {
        if (this.assetInfo[assetChain] == undefined) {
            throw new paraTool.InvalidError(`Invalid asset: ${assetChain}`)
        }
        try {
            let [asset, chainID] = paraTool.parseAssetChain(assetChain)
            let w = (chainID) ? ` and chainID = '${chainID}'` : "";
            let sql = `select holder, free, reserved, miscFrozen, frozen  from assetholder${chainID} where asset = '${asset}' ${w} order by free desc limit ${limit}`
            let holders = await this.poolREADONLY.query(sql);

            let ts = this.currentTS();
            for (let i = 0; i < holders.length; i++) {
                holders[i].free = parseFloat(holders[i].free);
                holders[i].reserved = parseFloat(holders[i].reserved);
                holders[i].miscFrozen = parseFloat(holders[i].miscFrozen);
                holders[i].frozen = parseFloat(holders[i].frozen);

                // transferable = free - misc_frozen
                holders[i].transferable = holders[i].free - holders[i].miscFrozen;
                let [transferableUSD, _, priceUSDCurrent] = await this.computeUSD(holders[i].transferable, asset, chainID, ts);
                holders[i].transferableUSD = transferableUSD;

                // balance = free + reserved
                holders[i].balance = holders[i].free + holders[i].reserved;
                holders[i].balanceUSD = priceUSDCurrent * holders[i].balance;

                holders[i].reservedUSD = priceUSDCurrent * holders[i].reserved;

                // fee_payable = free - fee_frozen ... but what is "Locked balance" vs "Frozen fee" since "miscFrozen" is always exactly "frozen"?
                holders[i].miscFrozenUSD = priceUSDCurrent * holders[i].miscFrozen;
                holders[i].frozenUSD = priceUSDCurrent * holders[i].frozen;
            }

            return holders;
        } catch (err) {
            this.logger.error({
                "op": "query.getAssetHolders",
                assetChain,
                err
            });
        }

    }

    async getAsset(assetChain, address = false, limit = 20) {
        try {
            let [asset, chainID] = paraTool.parseAssetChain(assetChain)
            let assets = await this.poolREADONLY.query(`select asset.*, chain.chainName from asset, chain where asset.asset = '${asset}' and asset.chainID = chain.chainID and asset.numHolders > 0 order by asset.numHolders desc limit ${limit}`);
            let realtime = (address) ? await this.getRealtimeAsset(address) : false;

            for (let i = 0; i < assets.length; i++) {
                let a = assets[i];
                let accountState = this.getHoldingsState(realtime, a.asset, a.chainID);
                if (accountState !== undefined) {
                    assets[i].accountState = this.getHoldingsState(realtime, a.asset, a.chainID);
                }
            }
            return (assets);
        } catch (err) {
            this.logger.error({
                "op": "query.getAsset",
                assetChain,
                err
            });
        }
    }

    getHoldingsState(holdings, asset, chainID) {
        if (!holdings) return (false);
        for (const assetType of Object.keys(holdings)) {
            let a = holdings[assetType];
            for (let i = 0; i < a.length; i++) {
                let b = a[i];
                if ((b.assetInfo.asset == asset) && (b.assetInfo.chainID == chainID)) {
                    return b.state;
                }
            }
        }
        return (undefined);
    }

    async getAssetsRelated(assetChain, address = false, limit = 100) {
        if (this.assetInfo[assetChain] == undefined) {
            throw new paraTool.InvalidError(`Invalid asset: ${assetChain}`)
        }
        let assets = [];
        try {
            let [asset, chainID] = paraTool.parseAssetChain(assetChain)
            if (!this.assetInfo) {
                console.log("getAssetsRelated MISS", assetChain);
                return (false);
            }
            for (const assetChainRelated of Object.keys(this.assetInfo)) {
                let assetInfoRelated = this.assetInfo[assetChainRelated];
                if (assetInfoRelated.token0 == asset || assetInfoRelated.token1 == asset) {
                    assets.push(assetInfoRelated);
                }
            }

            let holdings = (address) ? await this.getRealtimeAsset(address) : false;
            for (let i = 0; i < assets.length; i++) {
                let a = assets[i];
                let assetType = (a.assetType) ? a.assetType : false;
                if (holdings[assetType] !== undefined) {
                    let h = holdings[assetType];
                    for (let j = 0; j < h.length; j++) {
                        let b = h[j];
                        if ((b.assetInfo.asset == a.asset) && (b.assetInfo.chainID == a.chainID)) {
                            a.accountState = b.state;
                        }
                    }
                }
            }
        } catch (err) {
            this.logger.error({
                "op": "query.getAssetsRelated",
                assetChain,
                err
            });
        }
        return (assets);
    }

    async getChainAssets(chainID_or_chainName, address = false) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) throw new NotFoundError(`Invalid chain: ${chainID_or_chainName}`)
        let chain = await this.getChain(chainID)
        let assets = [];
        let holdings = null
        try {
            holdings = (this.validAddress(address)) ? await this.getRealtimeAsset(address) : false;
        } catch (err) {
            // its ok to have an error, no need to log it
        }
        try {
            var sql = `select assetType, assetName, numHolders, asset, chainID, priceUSD, symbol, decimals, token0, token1, token0Decimals, token1Decimals, token0Symbol, token1Symbol, totalFree, totalReserved, totalMiscFrozen, totalFrozen, token0Supply, token1Supply, totalSupply from asset where assetType not in ('Unknown', 'NFT') and chainID = '${chainID}' and numHolders > 0 order by numHolders desc, asset limit 500`
            assets = await this.poolREADONLY.query(sql);
            let ts = this.getCurrentTS();
            for (let i = 0; i < assets.length; i++) {
                let v = assets[i];
                let a = {};
                let assetChain = paraTool.makeAssetChain(v.asset, chainID);

                if (v.assetType == 'LiquidityPair' || v.assetType == 'ERC20LP') { //'ERC20','ERC20LP','ERC721','ERC1155','Token','LiquidityPair','NFT','Loan','Special'
                    a = {
                        assetType: v.assetType,
                        assetName: v.assetName,
                        numHolders: v.numHolders,
                        asset: v.asset,
                        symbol: v.symbol,
                        token0: v.token0,
                        token0Symbol: v.token0Symbol,
                        token0Decimals: v.token0Decimals,
                        token1: v.token1,
                        token1Symbol: v.token1Symbol,
                        token1Decimals: v.token1Decimals,
                        decimals: v.decimals,
                        chainID: v.chainID,
                        chainName: v.chainName,
                        assetChain: assetChain,
                        priceUSD: 0,
                        tvl: 0
                    }
                    let [amountUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(1.0, v.asset, chainID, ts)
                    a.priceUSD = priceUSDCurrent;
                    let latestDexRec = await this.getDexRec(v.asset, v.chainID, ts);
                    a.token0Supply = latestDexRec.lp0;
                    a.token1Supply = latestDexRec.lp1;
                    let priceUSD0 = await this.getTokenPriceUSD(v.token0, v.chainID, ts);
                    let priceUSD1 = await this.getTokenPriceUSD(v.token1, v.chainID, ts);
                    a.tvl = priceUSD0 * a.token0Supply + priceUSD1 * a.token1Supply;
                } else {
                    //does not have assetPair, token0, token1, token0Symbol, token1Symbol, token0Decimals, token1Decimals
                    a = {
                        assetType: v.assetType,
                        assetName: v.assetName,
                        numHolders: v.numHolders,
                        asset: v.asset,
                        symbol: v.symbol,
                        decimals: v.decimals,
                        chainID: v.chainID,
                        chainName: v.chainName,
                        assetChain: assetChain,
                        priceUSD: 0,
                        tvl: 0
                    }
                    let [amountUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(1.0, v.asset, chainID, ts);
                    a.priceUSD = priceUSD;
                    if (a.priceUSD == null) a.priceUSD = 0
                    if (v.assetType == "ERC20") {
                        a.totalSupply = parseFloat(v.totalSupply)
                        a.tvl = a.priceUSD * a.totalSupply
                    } else {
                        if (a.totalFree == null) a.totalFree = 0
                        a.totalFree = parseFloat(v.totalFree)
                        a.tvl = a.priceUSD * a.totalFree
                    }
                }
                assets[i] = a
                let assetType = (a.assetType) ? a.assetType : false;
                if (holdings[assetType] !== undefined) {
                    let h = holdings[assetType];
                    for (let j = 0; j < h.length; j++) {
                        let b = h[j];
                        if ((b.assetInfo.asset == a.asset) && (b.assetInfo.chainID == a.chainID)) {
                            a.accountState = b.state;
                        }
                    }
                }
            }
        } catch (err) {
            console.log(err);
            this.logger.error({
                "op": "query.getChainAssets",
                chainID_or_chainName,
                err
            });
        }
        return assets;
    }

    async getBlockHashFinalized(chainID, blockNumber) {
        let sql = `select blockHash, if(blockDT is Null, 0, 1) as finalized from block${chainID} where blockNumber = '${blockNumber}' and blockDT is not Null`
        let blocks = await this.poolREADONLY.query(sql);
        if (blocks.length == 1) {
            return blocks[0].blockHash;
        }
    }

    async getChainRecentBlocks(chainID_or_chainName, startBN = false, limit = 50) {
        let chain = await this.getChain(chainID_or_chainName);
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) return ([]);
        if (!startBN) startBN = chain.blocksCovered - limit;
        try {
            let evmflds = (chain.isEVM) ? ", numTransactionsEVM, numTransactionsInternalEVM, gasUsed" : "";
            let sql = `select blockNumber, if(blockDT is Null, 0, 1) as finalized, blockHash, blockDT, UNIX_TIMESTAMP(blockDT) as blockTS, numExtrinsics, numEvents, numTransfers, numSignedExtrinsics, numXCMTransfersIn, numXCMTransfersOut, numXCMMessagesOut, numXCMMessagesIn, valueTransfersUSD ${evmflds} from block${chainID} where blockNumber > ${startBN} order by blockNumber Desc limit ${limit}`
            let blocks = await this.poolREADONLY.query(sql);
            let blocksunfinalized = await this.poolREADONLY.query(`select blockNumber, blockHash, UNIX_TIMESTAMP(blockDT) as blockTS, numExtrinsics, numEvents, numTransfers, numSignedExtrinsics, valueTransfersUSD from blockunfinalized where chainID = ${chainID} and blockNumber >= ${startBN}`);
            let bufData = {};
            let bufBlockHashes = {};
            for (let b = 0; b < blocksunfinalized.length; b++) {
                let bn = blocksunfinalized[b].blockNumber;
                if (bufBlockHashes[bn] == undefined) {
                    bufBlockHashes[bn] = [];
                }
                bufBlockHashes[bn].push(blocksunfinalized[b].blockHash);
                bufData[bn] = blocksunfinalized[b];
            }

            for (let b = 0; b < blocks.length; b++) {
                let bn = blocks[b].blockNumber;
                if ((blocks[b].finalized == 0) && bufBlockHashes[bn] !== undefined) {
                    blocks[b].blockHash = bufBlockHashes[bn];
                    if (bufData[bn] !== undefined) {
                        blocks[b].blockTS = bufData[bn].blockTS;
                        blocks[b].numExtrinsics = bufData[bn].numExtrinsics;
                        blocks[b].numEvents = bufData[bn].numEvents;
                        blocks[b].numTransfers = bufData[bn].numTransfers;
                        blocks[b].valueTransfersUSD = bufData[bn].valueTransfersUSD;
                    }
                }
            }
            return (blocks);
        } catch (err) {
            this.logger.error({
                "op": "query.getChainRecentBlocks",
                chainID_or_chainName,
                err
            });

        }
        return ([]);
    }

    async decorateBlock(block, chainID, evmBlock = false, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        try {
            let exts = block.extrinsics
            let decoratedExts = []
            for (const d of exts) {
                //let de = await this.decorateBlockExtrinsic(d, chainID, block.blockTS, decorate, decorateExtra)
                let de = await this.decorateExtrinsic(d, chainID, "", decorate, decorateExtra)
                decoratedExts.push(de)
            }
            block.extrinsics = decoratedExts
            if (decorate && block.author != undefined) {
                block.authorAddress = paraTool.getPubKey(block.author)
                this.decorateAddress(block, "authorAddress", decorateAddr, false)
            } else if (evmBlock && evmBlock.author != undefined) {
                block.author = evmBlock.author
                block.authorAddress = paraTool.getPubKey(evmBlock.author)
                this.decorateAddress(block, "authorAddress", decorateAddr, false)
            }

            block.specVersion = this.getSpecVersionForBlockNumber(chainID, block.number);
            if (evmBlock) {
                block.evmBlock = evmBlock
            }
        } catch (err) {
            this.logger.error({
                "op": "decorateBlock",
                chainID,
                number: block.number,
                err
            });
        }
        return block
    }

    async decorateTrace(trace, chainID, blockNumber) {
        try {
            let traceIdx = 0
            for (const kv of trace) {
                kv.traceID = `${blockNumber}-${traceIdx}`
                let [section, storage] = this.lookup_trace_sectionStorage(kv.k, kv.v);
                if (section || storage) {
                    kv.section = section;
                    kv.storage = storage;
                }
                traceIdx++
            }
        } catch (err) {
            this.logger.error({
                "op": "decorateTrace",
                chainID,
                number: blockNumber,
                err
            });
        }
        return trace
    }

    async decorateAutoTrace(trace, chainID, blockNumber) {
        try {
            for (const kv of trace) {
                if (kv.p != undefined || kv.s != undefined) {
                    kv.section = kv.p;
                    kv.storage = kv.s;
                    delete kv.p;
                    delete kv.s;
                }
            }
        } catch (err) {
            this.logger.error({
                "op": "decorateTrace",
                chainID,
                number: blockNumber,
                err
            });
        }
        return trace
    }

    convertChainID(chainID_or_chainName) {
        let chainID = false
        let id = false
        try {
            chainID = parseInt(chainID_or_chainName, 10);
            if (isNaN(chainID)) {
                [chainID, id] = this.getChainIDByName(chainID_or_chainName)
            } else {
                [chainID, id] = this.getNameByChainID(chainID_or_chainName)
            }
        } catch (e) {
            [chainID, id] = this.getChainIDByName(chainID_or_chainName)
        }
        //console.log(`chainID=${chainID}, id=${id}, chainID_or_chainName=${chainID_or_chainName}`)
        return [chainID, id]
    }

    async getBlock(chainID_or_chainName, blockNumber, blockHash = false, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) throw new paraTool.NotFoundError(`Invalid chain: ${chainID_or_chainName}`)
        let chain = await this.getChain(chainID);
        if (blockNumber > chain.blocksCovered) {
            throw new paraTool.InvalidError(`Invalid blockNumber: ${blockNumber} (tip: ${chain.blocksCovered})`)
        }
        try {
            let families = ["feed", "finalized", "feedevm"];
            let row = await this.fetch_block(chainID, blockNumber, families, true, blockHash);
            // TODO: check response
            let block = row.feed;
            if (block) {
                block = await this.decorateBlock(row.feed, chainID, row.evmFullBlock, decorate, decorateExtra);

                let sql = `select numXCMTransfersIn, numXCMMessagesIn, numXCMTransfersOut, numXCMMessagesOut, valXCMTransferIncomingUSD, valXCMTransferOutgoingUSD from block${chainID} where blockNumber = '${blockNumber}' limit 1`;
                let blockStatsRecs = await this.poolREADONLY.query(sql);
                if (blockStatsRecs.length == 1) {
                    let s = blockStatsRecs[0];
                    block.numXCMTransfersIn = s.numXCMTransfersIn;
                    block.numXCMMessagesIn = s.numXCMMessagesIn;
                    block.numXCMTransfersOut = s.numXCMTransfersOut;
                    block.numXCMMessagesOut = s.numXCMMessagesOut;
                    block.valXCMTransferIncomingUSD = s.valXCMTransferIncomingUSD;
                    block.valXCMTransferOutgoingUSD = s.valXCMTransferOutgoingUSD;
                }
                return block;
            } else {
                throw new paraTool.NotFoundError(`Block not indexed yet: ${blockNumber}`)
            }
        } catch (err) {
            if (err.code == 404) {
                throw new paraTool.NotFoundError(`Block not found: ${blockNumber}`)
            }
            this.logger.error({
                "op": "query.getBlock",
                chainID,
                blockNumber,
                blockHash,
                err
            });
        }
        return false;
    }

    async getTrace(chainID_or_chainName, blockNumber, blockHash = false) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) {
            throw new paraTool.NotFoundError(`Invalid chain: ${chainID_or_chainName}`)
        }
        let chain = await this.getChain(chainID);
        if (blockNumber > chain.blocksCovered) {
            throw new paraTool.InvalidError(`Invalid blockNumber: ${blockNumber} (tip: ${chain.blocksCovered})`)
        }
        let traces = [];
        try {
            const filter = {
                filter: [{
                    family: ["finalized", "trace", "autotrace", "n"],
                    cellLimit: 100
                }]
            };

            const tableChain = this.getTableChain(chainID);
            const [row] = await tableChain.row(paraTool.blockNumberToHex(blockNumber)).get(filter);
            let rowData = row.data
            if (rowData) {
                let nData = rowData.n;
                let traceType = "unknown";
                for (const k of Object.keys(nData)) {
                    if (k == "traceType") {
                        traceType = nData[k][0].value;
                        break;
                    }
                }

                let finalizedData = rowData.finalized;
                let finalizedHashes = {};
                let bh = null;
                let finalized = false;
                if (finalizedData) {
                    for (const k of Object.keys(finalizedData)) {
                        finalizedHashes[k] = true;
                        finalized = true;
                        bh = k;
                        break;
                    }
                }
                let autoTraceData = rowData.autotrace;
                let traceData = rowData.trace;
                if (autoTraceData) {
                    for (const k of Object.keys(autoTraceData)) {
                        if (k == "raw" || (bh != null && (finalizedHashes[k] != undefined)) || bh == null) {
                            let t = JSON.parse(autoTraceData[k][0].value);
                            let out = {};
                            if (k == "raw" && bh != null && finalized) {
                                out.blockHash = bh
                                out.finalized = true;
                            } else if (k != "raw" && finalized && (k == bh)) {
                                out.blockHash = k;
                                out.finalized = true;
                            } else if (!finalized && ((blockHash == false) || (blockHash == k))) {
                                out.blockHash = k;
                            }
                            if (out.blockHash != undefined) {
                                out.traceType = traceType;
                                out.trace = await this.decorateAutoTrace(t, chainID, blockNumber);
                                traces.push(out);
                            }
                            break;
                        }
                    }
                } else if (traceData) {
                    for (const k of Object.keys(traceData)) {
                        if (k == "raw" || (bh != null && (finalizedHashes[k] != undefined)) || bh == null) {
                            let t = JSON.parse(traceData[k][0].value);
                            let out = {};
                            if (k == "raw" && bh != null && finalized) {
                                out.blockHash = bh
                                out.finalized = true;
                            } else if (k != "raw" && finalized && (k == bh)) {
                                out.blockHash = k;
                                out.finalized = true;
                            } else if (!finalized && ((blockHash == false) || (blockHash == k))) {
                                out.blockHash = k;
                            }
                            if (out.blockHash != undefined) {
                                out.traceType = traceType;
                                out.trace = await this.decorateTrace(t, chainID, blockNumber);
                                traces.push(out);
                            }
                            break;
                        }
                    }
                }
            }

            return traces;
        } catch (err) {
            this.logger.error({
                "op": "query.getTrace",
                chainID,
                blockNumber,
                blockHash,
                err
            });
        }
        return traces;
    }


    async getBlockByHash(blockHash = false, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let res = await this.lookupHash(blockHash)
        if (res.hashType == "substrateBlockHash" || res.hashType == "evmBlockHash") {
            /*{
                "hash": "0xd62500cbc13a6d68aa3ad9131b54951a11bed3bc19ba8aebfda933fca6f443a2",
                "hashType": "evmBlockHash",
                "status": "finalized",
                "chainID": "2004",
                "blockNumber": 808508
            }
            */
            if (res.status == "finalized" || res.status == "unfinalized") {
                let chainID = res.chainID
                let blockNumber = res.blockNumber
                let block = await this.getBlock(chainID, blockNumber, blockHash, decorate, decorateExtra)
                if (res.hashType == "evmBlockHash" && block.evmBlock) {
                    // return just the evmBlock is looked up by evmBlockHash
                    return block.evmBlock
                } else {
                    block.chainID = res.chainID
                    return block
                }
            }
        }
        return false
    }

    parse_date(d) {
        return d; // TODO
    }

    parse_asset(a) {
        let [assetUnparsed, chainID] = paraTool.parseAssetChain(a);
        return (assetUnparsed);
    }

    async getAccountBalances(rawAddress, lookback = 180, ts = null, maxRows = 1000) {
        let chainList = []
        let balances = await this.getAccount(rawAddress, "balances", chainList, maxRows, ts, lookback);
        // TODO: treat "false" case
        return (balances);
    }

    async getAccountUnfinalized(rawAddress, lookback = 180, ts = null, maxRows = 1000) {
        let chainList = []
        let unfinalized = await this.getAccount(rawAddress, "unfinalized", chainList, maxRows, ts, lookback);
        // TODO: treat "false" case
        return (unfinalized);
    }

    page_params(ts, limit, p, chainList, decorate, decorateExtra) {
        let out = `ts=${ts}&limit=${limit}`
        if (p > 0) out += `&p=${p}`
        if (chainList.length > 0) {
            out += `&chainfilters=` + chainList.join(",");
        }
        if (decorate) {
            out += `&decorateExtra=` + decorateExtra.join(",");
        }
        return out;
    }


    async get_account_extrinsics_unfinalized(address, rows, maxRows = 1000, chainList = [], decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let feedItems = 0;
        let isEVMAddr = paraTool.isValidEVMAddress(address)
        var decoratedFeeds = []

        if (rows && rows.length > 0) {
            for (const row of rows) {
                let rowData = row.data
                if (rowData["feedunfinalized"]) {
                    let [addressPiece, ts, extrinsicHashPiece] = paraTool.parse_addressExtrinsic_rowKey(row.id)
                    let extrinsics = rowData["feedunfinalized"];
                    for (const extrinsicHashEventID of Object.keys(extrinsics)) {
                        for (const cell of extrinsics[extrinsicHashEventID]) {
                            var t = JSON.parse(cell.value);
                            if (this.chainFilters(chainList, t.chainID) && feedItems < maxRows && decoratedFeeds[extrinsicHashPiece] == undefined) {
                                let d = await this.decorateExtrinsic(t, t.chainID, "", decorate, decorateExtra)
                                decoratedFeeds[extrinsicHashPiece] = {
                                    extrinsicHash: extrinsicHashPiece,
                                    ts: parseInt(t.ts, 10),
                                    params: t.params,
                                    section: d.section,
                                    method: d.method,
                                    id: d.id,
                                    chainID: parseInt(t.chainID, 10),
                                    chainName: this.getChainName(t["chainID"]),
                                    finalized: 0
                                }
                            }
                            break;
                        }
                    }
                }
                if (rowData["feed"]) {
                    let [addressPiece, ts, extrinsicHashPiece] = paraTool.parse_addressExtrinsic_rowKey(row.id)
                    let extrinsics = rowData["feed"];
                    for (const extrinsicHashEventID of Object.keys(extrinsics)) {
                        for (const cell of extrinsics[extrinsicHashEventID]) {
                            var t = JSON.parse(cell.value);
                            if (this.chainFilters(chainList, t.chainID) && decoratedFeeds[extrinsicHashPiece] != undefined) {
                                decoratedFeeds[extrinsicHashPiece]['extrinsicID'] = t.extrinsicID;
                                decoratedFeeds[extrinsicHashPiece]['blockNumber'] = parseInt(t.blockNumber, 10);
                                decoratedFeeds[extrinsicHashPiece]['ts'] = parseInt(t.ts, 10);
                                decoratedFeeds[extrinsicHashPiece]['finalized'] = 1;
                            }
                            break;
                        }
                    }
                }
            }
        }
        let unfinalized = [];
        for (const extrinsicHash of Object.keys(decoratedFeeds)) {
            unfinalized.push(decoratedFeeds[extrinsicHash])
        }
        return unfinalized
    }

    //cbt read addressextrinsic prefix=0x109d58c19ac53a8cf9fe9793e0ae027d5dada0b79e6f6ee81a8fbe4cb0955649
    async get_account_extrinsics(address, rows, maxRows = 1000, chainList = [], decorate = true, decorateExtra = ["data", "address", "usd", "related"], TSStart = null, pageIndex = 0) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let feed = [];
        let feedItems = 0;
        let isEVMAddr = paraTool.isValidEVMAddress(address)
        var decoratedFeeds = []
        let decorateEvents = decorateExtra.includes("events");
        let p = 0;
        let pTS = null;
        if (rows && rows.length > 0) {
            for (const row of rows) {
                let rowData = row.data
                if (rowData["feed"]) {
                    let [addressPiece, ts, extrinsicHashPiece] = paraTool.parse_addressExtrinsic_rowKey(row.id)
                    let extrinsics = rowData["feed"];
                    if (pTS != ts) {
                        p = 0;
                        pTS = ts;
                    }
                    for (const extrinsicHashEventID of Object.keys(extrinsics)) {
                        for (const cell of extrinsics[extrinsicHashEventID]) {
                            var t = JSON.parse(cell.value);
                            if (!this.chainFilters(chainList, t.chainID)) {
                                //filter non-specified records .. do not decorate
                                continue
                            }
                            let isEVMTx = (t.transactionHash != undefined) ? true : false
                            if (isEVMTx) {
                                // this is an EVM tx
                                let c = t
                                let decodedInput = t['decodedInput']
                                if (decodedInput != undefined && decodedInput.signature != undefined) {
                                    c.method = decodedInput.methodID
                                    let sa = decodedInput.signature.split('(');
                                    c.section = (sa.length > 0) ? sa[0] : "Unknown";
                                } else {
                                    c.method = "Unknown";
                                    c.section = "Unknown";
                                }
                                if (decorate) {
                                    this.decorateAddress(c, "fromAddress", decorateAddr, decorateRelated)
                                    this.decorateAddress(c, "from", decorateAddr, decorateRelated)
                                }
                                if (c.to && c.to.length > 0) {
                                    if (decorate) this.decorateAddress(c, "to", decorateAddr, decorateRelated)
                                    let assetChain = paraTool.makeAssetChain(c.to.toLowerCase(), c.chainID);
                                    if (this.assetInfo[assetChain]) {
                                        c.assetInfo = this.assetInfo[assetChain];
                                    }
                                }
                                c.chainName = this.getChainName(c.chainID)
                                let cTimestamp = c.timestamp
                                let chainAsset = this.getChainAsset(c.chainID)
                                if (decorateUSD) {
                                    let [valueUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(c.value, chainAsset, c.chainID, cTimestamp);
                                    c.valueUSD = valueUSD;
                                    c.priceUSD = priceUSD;
                                    c.priceUSDCurrent = priceUSDCurrent;
                                    c.symbol = this.getChainSymbol(c.chainID);
                                    c.feeUSD = c.fee * c.priceUSD;
                                } else {
                                    c.symbol = this.getChainSymbol(c.chainID);
                                }
                                c.result = c.status // this is success/fail indicator of the evm tx
                                // decorate transfers
                                if (c.transfers !== undefined && c.transfers.length > 0) {
                                    for (let i = 0; i < c.transfers.length; i++) {
                                        let t = c.transfers[i];
                                        if (decorateAddr) {
                                            this.decorateAddress(t, "from", decorateAddr, decorateRelated)
                                            this.decorateAddress(t, "to", decorateAddr, decorateRelated)
                                        }
                                        let tokenAsset = t.tokenAddress.toLowerCase();
                                        let tokenAssetChain = paraTool.makeAssetChain(tokenAsset, c.chainID);
                                        if (this.assetInfo[tokenAssetChain]) {
                                            t.assetInfo = this.assetInfo[tokenAssetChain];
                                            if (t.assetInfo.decimals !== false) {
                                                t.value = t.value / 10 ** t.assetInfo.decimals;
                                                if (decorateUSD) {
                                                    let [valueUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(t.value, tokenAsset, c.chainID, cTimestamp);
                                                    t.valueUSD = valueUSD;
                                                    t.priceUSD = priceUSD;
                                                    t.priceUSDCurrent = priceUSDCurrent;
                                                }
                                            }
                                        }
                                    }
                                }
                                if (TSStart && (t['ts'] == TSStart) && (p < pageIndex)) {
                                    console.log("SKIPPING (p<pageIndex)", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    // skip this until hitting pageIndex
                                    p++;
                                } else if (feedItems < maxRows) {
                                    p++;
                                    decoratedFeeds.push(c)
                                    feedItems++;
                                } else if (feedItems == maxRows) {
                                    return {
                                        data: decoratedFeeds,
                                        nextPage: `/account/extrinsics/${address}?` + this.page_params(ts, maxRows, p, chainList, decorate, decorateExtra)
                                    }
                                    break;
                                }
                            } else {
                                if (t['extrinsicHash'] == undefined) {
                                    t['extrinsicHash'] = extrinsicHashPiece;
                                }
                                if (t['result'] == undefined) {
                                    t['result'] = 1; //mark old record as sucess for now
                                }
                                t['blockNumber'] = parseInt(t.blockNumber, 10);
                                t['chainID'] = parseInt(t.chainID, 10);
                                t['chainName'] = this.getChainName(t["chainID"]);
                                t['nonce'] = parseInt(t.nonce, 10);
                                t['ts'] = parseInt(t.ts, 10);
                                if (t.params) t['params'] = t.params;
                                if (t.events) {
                                    if (decorateEvents) {} else {
                                        delete t['events'];
                                    }
                                }
                                if (TSStart && (t['ts'] == TSStart) && (p < pageIndex)) {
                                    console.log("SKIPPING (p<pageIndex)", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    // skip this until hitting pageIndex
                                    p++;
                                } else if (feedItems < maxRows) {
                                    console.log("INCLUDING", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    p++;
                                    let d = await this.decorateExtrinsic(t, t.chainID, "", decorate, decorateExtra)
                                    decoratedFeeds.push(d)
                                    feedItems++;
                                } else if (feedItems == maxRows) {
                                    return {
                                        data: decoratedFeeds,
                                        nextPage: `/account/extrinsics/${address}?` + this.page_params(ts, maxRows, p, chainList, decorate, decorateExtra)
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        return {
            data: decoratedFeeds,
            nextPage: null
        };
    }

    async get_account_transfers(address, rows, maxRows = 1000, chainList = [], decorate = true, decorateExtra = ["data", "address", "usd", "related"], TSStart = null, pageIndex = 0) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let feedTransfer = [];
        let feedTransferItems = 0;
        let p = 0;
        let pTS = null;
        let prevKey = false;
        if (rows && rows.length > 0) {
            for (const row of rows) {
                let rowData = row.data
                if (rowData["feedtransfer"]) {
                    let [accKey, ts, extrinsicHash] = paraTool.parse_addressExtrinsic_rowKey(row.id)
                    let extrinsicsTransfer = rowData["feedtransfer"]; // TODO: feedtransferunfinalized
                    if (pTS != ts) {
                        p = 0;
                        pTS = ts;
                    }
                    //transfer:extrinsicHash [rows]
                    //tranfers:extrinsicHash#eventID
                    //tranfers:0x0804ea6287afaf070b7717505770da790785b0b36d34529d51b5c9670ea49cb5#5-324497-0-0 @ 2022/02/01-16:47:48.000000

                    //for each feedtransfer:extrinsicHash row, reverse the cells
                    for (const extrinsicHashEventID of Object.keys(extrinsicsTransfer).reverse()) {
                        //let extrinsicsTransferCells = extrinsicsTransfer[extrinsicHashEventID]
                        //console.log(`extrinsicsTransfer[${extrinsicHashEventID}] length=${extrinsicsTransferCells.length}`)
                        for (const cell of extrinsicsTransfer[extrinsicHashEventID]) {
                            try {
                                let extrinsicHash = extrinsicHashEventID.split('#')[0]
                                let eventID = extrinsicHashEventID.split('#')[1]
                                var t = JSON.parse(cell.value);
                                if (!this.chainFilters(chainList, t.chainID)) {
                                    //filter non-specified records .. do not decorate
                                    continue
                                }
                                //console.log(`extrinsicHash`, t)
                                if (t['extrinsicHash'] != undefined) {
                                    t['extrinsicHash'] = extrinsicHash;
                                }
                                t['blockNumber'] = parseInt(t.blockNumber, 10);
                                t['chainID'] = parseInt(t.chainID, 10);
                                t['chainName'] = this.getChainName(t["chainID"]);

                                let [__, id] = this.convertChainID(t.chainID);
                                t['id'] = id
                                if (t.ts) t['ts'] = parseInt(t.ts, 10);

                                let tt = await this.decorateQueryFeedTransfer(t, t.chainID, decorate, decorateExtra)
                                let currKey = `${tt.extrinsicHash}|${tt.fromAddress}|${tt.toAddress}|${tt.rawAmount}` // it's probably "safe" to check without asset type here.
                                if (currKey == prevKey) {
                                    console.log(`skip duplicate [${tt.eventID}] (${tt.transferType}, ${currKey})`)
                                } else if (TSStart && (t['ts'] == TSStart) && (p < pageIndex)) {
                                    console.log("SKIPPING (p<pageIndex)", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    // skip this until hitting pageIndex
                                    p++;
                                } else if (feedTransferItems < maxRows) {
                                    console.log("INCLUDING", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    p++;
                                    feedTransfer.push(tt);
                                    feedTransferItems++;
                                } else if (feedTransferItems == maxRows) {
                                    return {
                                        data: feedTransfer,
                                        nextPage: `/account/transfers/${address}?` + this.page_params(ts, maxRows, p, chainList, decorate, decorateExtra)
                                    }
                                }
                                console.log("prevkey SET", currKey);
                                prevKey = currKey
                            } catch (err) {
                                // bad data
                                console.log(err);
                            }
                            break;
                        }
                    }
                }
            }
        }
        return {
            data: feedTransfer,
            nextPage: null
        }
    }

    // column: link
    // cell value: { title, description, metadata, linktype }
    async get_hashes_related(address, relatedData, hashesType = "address") {
        console.log("get_hashes_related", address);
        let related = [];
        if (relatedData) {
            for (const col of Object.keys(relatedData)) {
                let cell = relatedData[col];
                try {
                    let res = JSON.parse(cell[0].value)

                    related.push(res);
                    if (res.description == "Reversed H160 Address") {
                        let reverseAddr = res.title
                        related.push({
                            "datasource": "NativeH160",
                            "url": "/account/" + reverseAddr, //this redirect to NativeH160 (moonbeam/moonriver case)
                            "title": reverseAddr,
                            "description": `Native H160 Address (Moonbeam, Moonriver)`,
                            "linktype": "address",
                            "metadata": {}
                        });
                    }
                } catch (err) {
                    console.log("RELATED ERR", err);
                }
            }
        }
        if (hashesType == "address") {
            if (paraTool.isValidSubstratePublicKey(address)) {
                // ss58Pubkey
                let ss58Pubkey = paraTool.getPubKey(address)
                related.push({
                    "datasource": "SS58",
                    "url": "/account/" + ss58Pubkey,
                    "title": ss58Pubkey,
                    "description": "SS58 Public Key",
                    "linktype": "address",
                    "metadata": {}
                });

                // ss58 substrate universal
                let substrateAddr = paraTool.getAddress(address, 42)
                related.push({
                    "datasource": "SS58",
                    "url": "/account/" + substrateAddr,
                    "title": substrateAddr,
                    "description": `SS58 Address: Substrate (Prefix: 42)`,
                    "linktype": "address",
                    "metadata": {}
                });
                // H160 link for this address
                let evmH160 = paraTool.pubkeyToH160(address)
                let h160SS58Pubkey = paraTool.h160ToPubkey(evmH160)
                let h160SubstrateAddr = paraTool.getAddress(h160SS58Pubkey)
                // h160SS58Pubkey is derived as first 20bytes of blake2("evm:20bytes(ss58Pubkey)), which is different from the original ss58Pubkey
                related.push({
                    "datasource": "H160",
                    "url": "/account/" + h160SS58Pubkey, // evmH160 is not directly searchable in our system. will have to redirect user to h160SS58Pubkey
                    "title": evmH160,
                    "description": `H160 Address`,
                    "linktype": "address",
                    "metadata": {}
                });

                /* H160 Public Key is too confusing, let's not show it
                related.push({
                    "datasource": "H160",
                    "url": "/account/" + h160SS58Pubkey,
                    "title": h160SS58Pubkey,
                    "description": `H160 Public Key`,
                    "linktype": "address",
                    "metadata": {}
                });
                related.push({
                    "datasource": "H160",
                    "url": "/account/" + h160SubstrateAddr,
                    "title": h160SubstrateAddr,
                    "description": `H160 SS58 Address: Substrate (Prefix: 42)`,
                    "linktype": "address",
                    "metadata": {}
                });
                */
                // add networkID based SS58 generation
                for (const chainID of Object.keys(this.chainInfos)) {
                    let chainName = this.getChainName(chainID);
                    let ss58Format = this.chainInfos[chainID].ss58Format;
                    let evmSS58 = paraTool.getAddress(address, ss58Format)
                    related.push({
                        "datasource": "SS58",
                        "url": "/account/" + evmSS58,
                        "title": evmSS58,
                        "description": `SS58 Address: ${chainName} (Prefix: ${ss58Format})`,
                        "linktype": "address",
                        "metadata": {}
                    });
                }
            } else if (paraTool.isValidEVMAddress(address)) {
                // Note: Astar public key ss58 generation -> recovery original ss58 from evmAddress is not possible
                // TODO: add xrc20 generation .. if the address is a contract Address
                // Input is H160 for this address
                let evmH160 = address
                let h160SS58Pubkey = paraTool.h160ToPubkey(evmH160)
                let h160SubstrateAddr = paraTool.getAddress(h160SS58Pubkey)
                // h160SS58Pubkey is derived as first 20bytes of blake2("evm:20bytes(ss58Pubkey)), which is different from the original ss58Pubkey
                related.push({
                    "datasource": "H160",
                    "url": "/account/" + h160SS58Pubkey, // evmH160 is not directly searchable in our system. will have to redirect user to h160SS58Pubkey
                    "title": evmH160,
                    "description": `H160 Address`,
                    "linktype": "address",
                    "metadata": {}
                });
                related.push({
                    "datasource": "NativeH160",
                    "url": "/account/" + address, //this redirect to NativeH160 (moonbeam/moonriver case)
                    "title": address,
                    "description": `Native H160 Address (Moonbeam, Moonriver)`,
                    "linktype": "address",
                    "metadata": {}
                });
            }
        }
        return (related)
    }

    async getAccountAssetsRealtimeByChain(requestedChainID, rawAddress, rawFromAddress, chainList = [], maxRows = 1000, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let fromAddress = paraTool.getPubKey(rawFromAddress) // observer
        let address = paraTool.getPubKey(rawAddress)
        let isEVMAddr = paraTool.isValidEVMAddress(address)

        let assets = null;
        try {
            assets = await this.getAccount(address, "realtime", chainList, maxRows);
        } catch (err) {
            console.log("getAccountAssetsRealtimeByChain", err);
            throw err;
        }

        let chainsMap = {};
        for (let i = 0; i < assets.length; i++) {
            let a = assets[i];
            let chainID = a.assetInfo.chainID;
            if (chainsMap[chainID] == undefined) {
                let chainInfo = this.chainInfos[chainID];
                var id, chainName, ss58Format, ss58Address, iconUrl, subscanURL, dappURL, WSEndpoint;
                if (chainInfo !== undefined) {
                    chainName = this.getChainName(chainID);
                    id = chainInfo.id;
                    ss58Format = this.chainInfos[chainID].ss58Format;
                    ss58Address = isEVMAddr ? false : paraTool.getAddress(address, ss58Format);
                    iconUrl = this.chainInfos[chainID].iconUrl;
                    subscanURL = this.chainInfos[chainID].subscanURL;
                    dappURL = this.chainInfos[chainID].dappURL;
		    WSEndpoint = this.chainInfos[chainID].WSEndpoint;
                }
                chainsMap[chainID] = {
                    chainID,
                    chainName,
                    id,
                    ss58Format,
                    ss58Address,
                    iconUrl,
                    subscanURL,
                    dappURL,
		    WSEndpoint,
                    assets: [],
                    balanceUSD: 0
                };
            }
            let o = a.assetInfo;
            o.state = a.state;
            chainsMap[a.assetInfo.chainID].assets.push(o);
        }
        // if we didn't get any assets at all for the requestedChainID, synthesize a 0 asset record so that the user can see it
        if (chainsMap[requestedChainID] == undefined && this.chainInfos[requestedChainID] != undefined) {
            let chainInfo = this.chainInfos[requestedChainID];
            let chainName = this.getChainName(requestedChainID);
            let id = chainInfo.id;
            let ss58Format = chainInfo.ss58Format;
            let ss58Address = isEVMAddr ? false : paraTool.getAddress(address, ss58Format);
            let iconUrl = chainInfo.iconUrl;
            let zeroAssets = [];
            chainsMap[requestedChainID] = {
                chainID: requestedChainID,
                chainName,
                id,
                ss58Format,
                ss58Address,
                iconUrl,
                assets: zeroAssets,
                balanceUSD: 0
            }
        }
        // turn chainsMap into chains array, and compute balanceUSD
        let chains = [];
        let balanceUSD = 0;
        for (const chainID of Object.keys(chainsMap)) {
            let chain = chainsMap[chainID];
            let chainBalanceUSD = 0;
            for (let j = 0; j < chain.assets.length; j++) {
                let a = chain.assets[j];
                if (a.state.balanceUSD !== undefined) {
                    chainBalanceUSD += a.state.balanceUSD;
                }
            }
            chain.assets.sort(function(a, b) {
                let bBalance = (b.state.balanceUSD !== undefined) ? b.state.balanceUSD : 0;
                let aBalance = (a.state.balanceUSD !== undefined) ? a.state.balanceUSD : 0;
                if (aBalance != bBalance) {
                    return (bBalance - aBalance);
                }
                let bFree = b.state.free !== undefined ? b.state.free : 0;
                let aFree = a.state.free !== undefined ? a.state.free : 0;
                if (aFree != bFree) {
                    return (bFree - aFree);
                }
                return 0;
            })
            chain.balanceUSD = chainBalanceUSD;
            balanceUSD += chain.balanceUSD;
            chains.push(chain);
        }

        // check asc vs desc
        chains.sort(function(a, b) {
            if (requestedChainID == a.chainID) {
                return -1;
            }
            if (requestedChainID == b.chainID) {
                return 1;
            }
            let bBalance = b.balanceUSD;
            let aBalance = a.balanceUSD;
            if (aBalance != bBalance) {
                return (bBalance - aBalance);
            }
            let bAssets = b.assets.length;
            let aAssets = a.assets.length;
            if (aAssets != bAssets) {
                return (bAssets - aAssets);
            }
            return (a.chainID - b.chainID);
        })

        let requestedChainPrefix = null;
        if (requestedChainID) {
            requestedChainPrefix = this.getChainPrefix(requestedChainID);
        } else if (chains.length > 0) {
            requestedChainPrefix = chains[0].ss58Format;
        } else {
            requestedChainPrefix = 0;
        }
        let requestedChainAddress = isEVMAddr ? address : paraTool.getAddress(address, requestedChainPrefix)
        let account = {
            address,
            requestedChainAddress,
            requestedChainPrefix,
            balanceUSD,
            chains,
            numFollowing: 0,
            numFollowers: 0,
            isFollowing: false,
            nickname: null,
            info: null,
            judgements: null,
            infoKSM: null,
            judgementsKSM: null,
            related: null
        }

        let a = this.lookup_account(address);
        if (a) {
            account.nickname = a.nickname;
            try {
                if (a.parentDisplay != null && a.subName) {
                    account.subName = `${a.parentDisplay}/${a.subName}`
                    account.parent = a.parent
                } else if (a.parentDisplayKSM != null && a.subNameKSM) {
                    account.subName = `${a.parentDisplayKSM}/${a.subNameKSM}`
                    account.parent = a.parentKSM
                } else {
                    account.subName = null;
                }
                account.info = (a.info != null) ? a.info : null;
                account.judgements = (a.judgements != null) ? a.judgements : null;
                account.infoKSM = (a.infoKSM != null) ? a.infoKSM : null;
                account.judgementsKSM = (a.judgementsKSM != null) ? a.judgementsKSM : null;
                account.related = (a.related != null) ? a.related : null;
            } catch (e) {
                console.log(e)
            }
            account.numFollowers = a.numFollowers;
            account.numFollowing = a.numFollowing;
            if (account.numFollowers > 0 && fromAddress) {
                let sql2 = `select isFollowing, followDT from follow where fromAddress = '${fromAddress}' and toAddress = '${address}'`
                let follows = await this.poolREADONLY.query(sql2);
                if (follows.length > 0) {
                    account.isFollowing = true;
                }
            }
        }
        return (account);
    }

    async get_account_realtime(address, realtimeData, chainList = []) {
        let realtime = {};
        if (realtimeData) {
            let lastCellTS = {};
            for (const assetChainEncoded of Object.keys(realtimeData)) {
                let cell = realtimeData[assetChainEncoded];
                let assetChain = paraTool.decodeAssetChain(assetChainEncoded);
                let [asset, chainID] = paraTool.parseAssetChain(assetChain);
                if (!this.chainFilters(chainList, chainID)) {
                    //filter non-specified records .. do not decorate
                    continue
                }
                if (chainID !== undefined) {
                    try {
                        let assetInfo = this.assetInfo[assetChain];
                        if (assetInfo == undefined) {
                            // console.log("NO ASSETINFO", assetChain, "asset", asset, "chainID", chainID, cell[0].value);
                        } else {
                            let assetType = assetInfo.assetType;
                            if (realtime[assetType] == undefined) {
                                realtime[assetType] = [];
                            }
                            let cellTS = cell[0].timestamp / 1000000;
                            if ((lastCellTS[assetChain] == undefined) || (lastCellTS[assetChain] > cellTS)) {
                                realtime[assetType].push({
                                    assetChain,
                                    assetInfo,
                                    state: JSON.parse(cell[0].value)
                                });
                                lastCellTS[assetChain] = cellTS;
                            }
                        }
                    } catch (err) {
                        console.log("REALTIME ERR", err);
                    }
                }
            }
        }

        let totalUSDVal = await this.compute_holdings_USD(realtime);
        let current = [];
        let covered = {};
        for (const k of Object.keys(realtime)) {
            let kassets = realtime[k];
            for (let j = 0; j < kassets.length; j++) {
                if (!covered[kassets[j].assetChain]) {
                    covered[kassets[j].assetChain] = true;
                    current.push(kassets[j]);
                }
            }
        }

        return (current);
    }

    async get_account_history(address, rows, maxRows = 1000, chainList = [], daily = false) {
        let history = {};
        let nHistoryItems = 0;
        let minTS = 0;
        let logDT = false;
        let logDTStr = "";
        let dailyhistory = {};
        if (rows && rows.length > 0) {
            for (const row of rows) {
                let rowData = row.data
                if (rowData["history"]) {
                    let historyData = rowData["history"];
                    let [accKey, ts] = paraTool.parse_addressHistory_rowKey(row.id)
                    for (const assetChainEncoded of Object.keys(historyData)) {
                        let assetChain = paraTool.decodeAssetChain(assetChainEncoded)
                        let [asset, chainID] = paraTool.parseAssetChain(assetChain);
                        if (!this.chainFilters(chainList, chainID)) {
                            //filter non-specified records .. do not decorate
                            continue
                        }
                        if (this.assetInfo[assetChain] !== undefined) {
                            let assetInfo = this.assetInfo[assetChain];
                            let assetType = assetInfo.assetType;
                            let targetAsset = assetInfo.asset;
                            for (const cell of historyData[assetChainEncoded]) {
                                var state = JSON.parse(cell.value);
                                let indexTS = cell.timestamp / 1000000;
                                if (history[assetChain] == undefined) {
                                    history[assetChain] = {
                                        assetInfo: assetInfo,
                                        states: []
                                    };
                                }
                                let flds = this.get_assetType_flds(assetType);
                                //compute asset history..
                                await this.decorate_assetState(assetInfo, state, flds, indexTS);
                                //console.log(`indexTS=${indexTS}`, decoratedState)
                                if (daily) {
                                    logDT = (daily) ? Math.round(indexTS / 86400) : 0;
                                    logDTStr = `${assetChain}-${logDT}`;
                                }
                                // if daily is true, we only want a single record (the first one) for each day for each assetChain
                                if ((nHistoryItems < maxRows && daily == false) || (daily && dailyhistory[logDTStr] == undefined)) {
                                    history[assetChain].states.push([indexTS, state]);
                                    if (daily) {
                                        dailyhistory[logDTStr] = true;
                                    }
                                    nHistoryItems++;
                                    minTS = ts
                                } else if (nHistoryItems == maxRows) {
                                    return {
                                        data: history,
                                        nextPage: `/account/history/${address}?` + this.page_params(ts, maxRows, p, chainList, decorate, decorateExtra),
                                        minTS
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }
        return {
            data: history,
            nextPage: null,
            minTS
        }
    }

    async get_account_crowdloans(address, rows, maxRows = 1000, chainList = [], decorate = true, decorateExtra = ["data", "address", "usd", "related"], TSStart = null, pageIndex = 0) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let crowdloans = [];
        let numItems = 0;
        let p = 0;
        let pTS = null;
        if (rows && rows.length > 0) {
            //console.log(`address=${address}, row.length=${rows.length}`)
            for (const row of rows) {
                let rowData = row.data
                if (rowData["feedcrowdloan"]) {
                    let crowdloansData = rowData["feedcrowdloan"];
                    let [accKey, ts, extrinsicHash] = paraTool.parse_addressExtrinsic_rowKey(row.id)
                    if (pTS != ts) {
                        p = 0;
                        pTS = ts;
                    }
                    for (const extrinsicHashEventID of Object.keys(crowdloansData)) {
                        //feedcrowdloan:extrinsicHash#eventID
                        //feedcrowdloan:0x4d709ef89a0d8b1f9c65b74ca87726cc236a4f1255738f3015944e5a20d712c8#0-7652261-7-47
                        for (const cell of crowdloansData[extrinsicHashEventID]) {
                            try {
                                var t = JSON.parse(cell.value);
                                if (!this.chainFilters(chainList, t.chainID)) {
                                    //filter non-specified records .. do not decorate
                                    continue
                                }
                                let extrinsicHash = extrinsicHashEventID.split('#')[0]
                                t['blockNumber'] = parseInt(t.blockNumber, 10);
                                t['chainID'] = parseInt(t.chainID, 10);
                                t['chainName'] = this.getChainName(t["chainID"]);
                                t['asset'] = this.getChainAsset(t["chainID"]);
                                if (decorateUSD) {
                                    let [amountUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(t['amount'], t['asset'], t['chainID'], t['ts']);
                                    t['amountUSD'] = amountUSD;
                                    t['priceUSD'] = priceUSD;
                                    t['priceUSDCurrent'] = priceUSDCurrent;
                                }
                                let relayChain = paraTool.getRelayChainByChainID(parseInt(t['chainID'], 10))
                                t['chainIDDest'] = paraTool.getChainIDFromParaIDAndRelayChain(parseInt(t['paraID'], 10), relayChain);

                                if (t['chainIDDest']) {
                                    t['chainDestName'] = this.getChainName(t['chainIDDest']);
                                    if (this.chainInfos[t['chainIDDest']] != undefined) {
                                        t['id'] = this.chainInfos[t['chainIDDest']].id;
                                        t['iconUrl'] = this.chainInfos[t['chainIDDest']].iconUrl;
                                        t['dappURL'] = this.chainInfos[t['chainIDDest']].dappURL;
                                        t['parachainsURL'] = this.chainInfos[t['chainIDDest']].parachainsURL;
                                    }
                                    if (TSStart && (t['ts'] == TSStart) && (p < pageIndex)) {
                                        console.log("SKIPPING (p<pageIndex)", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                        // skip this until hitting pageIndex
                                        p++;
                                    } else if (numItems < maxRows) {
                                        p++;
                                        crowdloans.push(t);
                                        numItems++;
                                    } else if (numItems == maxRows) {
                                        return {
                                            data: crowdloans,
                                            nextPage: `/account/crowdloans/${address}?` + this.page_params(ts, maxRows, p, chainList, decorate, decorateExtra),
                                        }
                                    }
                                }
                                break;
                            } catch (err) {
                                console.log(err);
                            }
                        }
                    }
                } else {
                    console.log(`address=${address}, rowData["feedcrowdloan"] not set`, row)
                }
            }
        }
        return {
            data: crowdloans,
            nextPage: null
        }
    }

    async get_account_rewards(address, rows, maxRows = 1000, chainList = [], decorate = true, decorateExtra = ["data", "address", "usd", "related"], TSStart = null, pageIndex = 0) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let rewards = [];
        let numItems = 0;
        let p = 0;
        let pTS = null;

        if (rows && rows.length > 0) {
            for (const row of rows) {
                let rowData = row.data
                if (rowData["feedreward"]) {
                    let [accKey, ts, extrinsicHash] = paraTool.parse_addressExtrinsic_rowKey(row.id)
                    if (pTS != ts) {
                        p = 0;
                        pTS = ts;
                    }
                    let rewardsData = rowData["feedreward"];
                    for (const extrinsicHashEventID of Object.keys(rewardsData)) {
                        //feedreward:extrinsicHash#eventID
                        //feedreward:0x0d27e60509f22a8d313fd69aa02442b23935e2ce9699b5a87a94eae8cc4c08c2#5-324060-2-58 @ 2022/02/01-15:17:12.000000
                        for (const cell of rewardsData[extrinsicHashEventID]) {
                            try {
                                var t = JSON.parse(cell.value);
                                if (!this.chainFilters(chainList, t.chainID)) {
                                    //filter non-specified records .. do not decorate
                                    continue
                                }
                                let extrinsicHash = extrinsicHashEventID.split('#')[0]
                                t['blockNumber'] = parseInt(t.blockNumber, 10);
                                t['chainID'] = parseInt(t.chainID, 10);
                                t['chainName'] = this.getChainName(t["chainID"]);
                                let [__, id] = this.convertChainID(t.chainID);
                                t['id'] = id
                                t['asset'] = this.getChainAsset(t["chainID"]);
                                if (decorateUSD) {
                                    let [amountUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(t['amount'], t['asset'], t['chainID'], t['ts']);
                                    t['amountUSD'] = amountUSD;
                                    t['priceUSD'] = priceUSD;
                                    t['priceUSDCurrent'] = priceUSDCurrent;
                                }
                                if (TSStart && (t['ts'] == TSStart) && (p < pageIndex)) {
                                    console.log("SKIPPING (p<pageIndex)", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    // skip this until hitting pageIndex
                                    p++;
                                } else if (numItems < maxRows) {
                                    console.log("INCLUDING", "ts", ts, "ts0", t['ts'], "p", p, "pageIndex", pageIndex)
                                    p++;
                                    rewards.push(t);
                                    numItems++;
                                } else if (numItems == maxRows) {
                                    return {
                                        data: rewards,
                                        nextPage: `/account/rewards/${address}?` + this.page_params(ts, maxRows, p, chainList, decorate, decorateExtra),
                                    }
                                }
                                break;
                            } catch (err) {
                                console.log(err);
                            }
                        }
                    }
                }
            }
        }
        return {
            data: rewards,
            nextPage: null
        }
    }

    clean_extrinsic_object(o) {
        if (o.chainID && typeof o.chainID == "string") {
            o.chainID = parseInt(o.chainID, 10);
        }
        if (o.chainIDDest && typeof o.chainIDDest == "string") {
            o.chainIDDest = parseInt(o.chainIDDest, 10);
        }
        if (o.blockNumber && typeof o.blockNumber == "string") {
            o.blockNumber = parseInt(o.blockNumber, 10);
        }
        return (o);
    }

    async getAccountFeed(fromAddress, chainList = [], maxRows = 1000, decorate = true, decorateExtra = ["data", "address", "usd", "related"], pageIndex = 0) {

        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

        let following = await this.getFollowing(fromAddress);
        let feed = [];
        if ((following == false) || (following.length == 0)) return (feed);
        let TSStart = this.currentTS() - 86400 * 3;
        let ranges = [];

        for (const f of following) {
            let startRow = f.toAddress;
            let endRow = f.toAddress + "#" + paraTool.inverted_ts_key(TSStart)
            // build filter for getRows call below
            ranges.push({
                start: startRow,
                end: endRow
            })
        }
        if (ranges.length == 0) {
            return (feed);
        }
        try {
            let [rows] = await this.btAddressExtrinsic.getRows({
                ranges: ranges,
                filter: [{
                    family: ["feed"],
                    cellLimit: 1
                }],
                limit: maxRows
            });
            let extrinsics = await this.get_account_extrinsics(fromAddress, rows, maxRows, chainList, decorate, decorateExtra);
            if (extrinsics.data) {
                for (let d = 0; d < extrinsics.data.length; d++) {
                    feed.push(extrinsics.data[d]);
                }
            }
        } catch (err) {
            this.logger.error({
                "op": "query.getAccountFeed",
                chainID,
                blockNumber,
                blockHash,
                err
            });

        }
        return {
            data: feed,
            nextPage: null
        };

    }

    async getBlockNumberByTS(chainID, ts, rangebackward = -1, rangeforward = 60) {
        let startTS = ts + rangebackward;
        let endTS = ts + rangeforward;
        let b0 = null;
        let b1 = null;
        let sql = `select blockNumber, blockDT, unix_timestamp(blockDT) as blockTS from block${chainID} where blockDT >= from_unixtime(${startTS}) and blockDT <= from_unixtime(${endTS}) order by blockNumber`;
        let blocks = await this.poolREADONLY.query(sql);
        for (let i = 0; i < blocks.length; i++) {
            let block = blocks[i];
            if (i == 0) {
                b0 = block.blockNumber;
            }
            if (i == blocks.length - 1) {
                b1 = block.blockNumber;
            }
        }
        return [b0, b1];
    }

    async getAccountRelated(address, decorate = true, decorateExtra = ["data", "address", "usd"]) {
        try {
            let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

            let a = this.lookup_account(address);
            if (a && a.related != undefined) {
                let related = [];
                for (let i = 0; i < a.related.length; i++) {
                    // TODO: add try catch
                    let r = a.related[i]
                    let r0 = JSON.parse(JSON.stringify(r));
                    if (decorate) {
                        this.decorateAddresses(r0, "signatories", decorateAddr, decorateRelated)
                        this.decorateAddresses(r0, "other_signatories", decorateAddr, decorateRelated)
                        this.decorateAddress(r0, "delegateOf", decorateAddr, decorateRelated);
                        this.decorateAddress(r0, "delegate", decorateAddr, decorateRelated);
                    }
                    delete r0.address;
                    related.push(r0);
                }
                return related;
            }
        } catch (err) {
            console.log(err);
        }
        return [];
    }

    async getAccountOffers(address, limit = 1000, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let sql = `select offer.offerID, offer.description, startDT, rewardAmount, rewardSymbol, rewardClaimed, chainID, blockNumber, blockTS, extrinsicID, extrinsicHash, claimDT from addressoffer join offer on addressoffer.offerID = offer.offerID where address = '${address}'`
        let claims = await this.poolREADONLY.query(sql);
        return claims;
    }

    async getSponsorOffers() {
        let sql = `select offerID, addressSponsor, balanceUSDMin, description, section, method, reward, symbol, targeting from offer where status = 'Active'`
        let offers = await this.poolREADONLY.query(sql);
        return offers;
    }

    getAddressTopNFilters() {
        return [{
                filter: 'balanceUSD',
                display: "Balance USD",
                type: "currency"
            }, {
                filter: 'numChains',
                display: "# Chains",
                type: "number"
            }, {
                filter: 'numAssets',
                display: "# Assets",
                type: "number"
            }, {
                filter: 'numTransfersIn',
                display: "# Transfers In",
                type: "number"
            }, {
                filter: 'avgTransferInUSD',
                display: "Avg Transfer In (USD)",
                type: "currency"
            }, {
                filter: 'sumTransferInUSD',
                display: "Total Transfers In (USD)",
                type: "currency"
            }, {
                filter: 'numTransfersOut',
                display: "# Transfers Out",
                type: "number"
            }, {
                filter: 'avgTransferOutUSD',
                display: "Avg Transfer Out (USD)",
                type: "currency"
            }, {
                filter: 'sumTransferOutUSD',
                display: "Total Transfers Out (USD)",
                type: "currency"
            }, {
                filter: 'numExtrinsics',
                display: "# Extrinsics",
                type: "number"
            }, {
                filter: 'numExtrinsicsDefi',
                display: "# Extrinsics (Defi)",
                type: "number"
            }, {
                filter: 'numCrowdloans',
                display: "# Crowdloans",
                type: "number"
            },
            //{filter:'numSubAccounts', display: "# Subaccounts", type: "number"},
            {
                filter: 'numRewards',
                display: "# Rewards",
                type: "number"
            }, {
                filter: 'rewardsUSD',
                display: "Rewards (USD)",
                type: "currency"
            }
        ];
    }

    async getAddressTopN(topN = "balanceUSD", decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let topNfilters = this.getAddressTopNFilters().map((f) => (f.filter));
        if (!topNfilters.includes(topN)) {
            throw new InvalidError(`Invalid filter ${topN}`)
        }
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

        let sql = `select N, address, balanceUSD, val from addressTopN where topN = '${topN}' order by N asc`
        let addressTopN = await this.poolREADONLY.query(sql);
        for (let i = 0; i < addressTopN.length; i++) {
            let a = addressTopN[i];
            if (decorate) this.decorateAddress(a, "address", decorateAddr, decorateRelated)
        }
        return addressTopN;
    }

    async getAccount(rawAddress, accountGroup = "realtime", chainList = [], maxRows = 1000, TSStart = null, lookback = 180, decorate = true, decorateExtra = ["data", "address", "usd", "related"], pageIndex = 0) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let address = paraTool.getPubKey(rawAddress)
        if (!this.validAddress(address)) {
            throw new paraTool.InvalidError(`Invalid address ${address}`)
        }
        var hrstart = process.hrtime()

        // xcmtransfers comes from mysql "xcmtransfer" table
        if (accountGroup == "xcmtransfers") {
            let filters = {
                chainList,
                address
            };
            return await this.getXCMTransfers(filters, maxRows, decorate, decorateExtra);
        }
        // xcmtransfers comes from mysql "xcmtransfer" table
        if (accountGroup == "feed") {
            return await this.getAccountFeed(address, chainList, maxRows, decorate, decorateExtra);
        }

        // offers are what is in progress and what has been claimed
        if (accountGroup == "offers") {
            return await this.getAccountOffers(address, maxRows, decorate, decorateExtra);
        }
        // related
        if (accountGroup == "related") {
            return await this.getAccountRelated(address, decorate, decorateExtra);
        }

        // everything else comes from the "address" table, but could come from other "addressextrinsic"
        // based on the account group, figure out the source tableName and families needed from the table

        //addressextrinsic: feed, feedtransfer, crowdloans, rewards
        //addressrealtime: realtime (default)
        //addresshistory: history
        //hash related

        let tableName = "addressrealtime"
        let families = []
        let TSpagination = false;
        switch (accountGroup) {
            case "extrinsics":
                tableName = "addressextrinsic"
                families.push("feed");
                TSpagination = true;
                break;
            case "unfinalized":
                tableName = "addressextrinsic"
                families.push("feed");
                families.push("feedunfinalized");
                TSpagination = false;
                break;
            case "transfers":
                tableName = "addressextrinsic"
                families.push("feedtransfer");
                TSpagination = true;
                break;
            case "crowdloans":
                tableName = "addressextrinsic"
                families.push("feedcrowdloan");
                TSpagination = true;
                break;
            case "rewards":
                tableName = "addressextrinsic"
                families.push("feedreward");
                TSpagination = true;
                break;
            case "realtime":
                tableName = "addressrealtime"
                families.push("realtime");
                break;
            case "ss58h160":
                tableName = "hashes"
                families.push("related");
                break;
            case "balances":
            case "history":
                tableName = "addresshistory"
                families.push("history");
                TSpagination = true;
                break;
            default:
                return false;
        }
        if (accountGroup == "balances") {
            maxRows = 1000;
        }
        let startRow = address;
        if (TSpagination && (TSStart != null)) {
            startRow = address + "#" + paraTool.inverted_ts_key(TSStart)
        }
        try {
            let row = false,
                rows = false
            if (tableName == "addressrealtime") {

                try {
                    let [tblName, tblRealtime] = this.get_btTableRealtime()
                    const filter = [{
                        column: {
                            cellLimit: 1
                        },
                        families: families,
                        limit: maxRows,
                    }];
                    [row] = await tblRealtime.row(address).get({
                        filter
                    });

                } catch (err) {
                    if (err.code == 404) {
                        throw new paraTool.NotFoundError(`Account not found ${address}`);
                    }
                    this.logger.error({
                        "op": "query.getAccount",
                        address,
                        accountGroup,
                        err
                    });
                    return false;
                }
            } else if (tableName == "addressextrinsic") {
                let endRow = address + "#ZZZ"
                if (accountGroup == "unfinalized") {
                    endRow = address + "#" + paraTool.inverted_ts_key(this.currentTS() - 3600 * 2);
                }
                try {
                    console.log("READING addressextrinsic", "startRow=", startRow, "endRow=", endRow, "TSStart=", TSStart)
                    let x = await this.btAddressExtrinsic.getRows({
                        start: startRow,
                        end: endRow,
                        limit: maxRows + 1,
                        filter: [{
                            family: families,
                            cellLimit: 1
                        }]
                    });
                    if (x.length > 0) {
                        [rows] = x;
                    }
                } catch (err) {
                    if (err.code == 404) {
                        throw Error(`Account not found ${address}`);
                    }
                    console.log(err);
                    this.logger.error({
                        "op": "query.getAccount",
                        address,
                        accountGroup,
                        err
                    });
                }
            } else if (tableName == "addresshistory") {
                try {
                    let [tblName, tblHistory] = this.get_btTableHistory();
                    [rows] = await tblHistory.getRows({
                        start: startRow,
                        end: address + "#ZZZ",
                        filter: [{
                            family: families,
                            cellLimit: 1
                        }],
                        limit: maxRows + 1
                    });
                } catch (err) {
                    if (err.code == 404) {
                        throw Error(`Account not found ${address}`)
                    }
                    this.logger.error({
                        "op": "query.getAccount",
                        address,
                        accountGroup,
                        err
                    });
                }
            } else if (tableName == "hashes") {

                const filter = [{
                    column: {
                        cellLimit: 1
                    },
                    limit: maxRows + 1,
                    families: families
                }];

                try {
                    [row] = await this.btHashes.row(address).get({
                        filter
                    });
                } catch (err) {
                    if (err.code == 404) {
                        //NO REASON TO throw an error, there are no "special" hashes
                    }
                    this.logger.error({
                        "op": "query.getAccount",
                        address,
                        accountGroup,
                        err
                    });
                }
            }

            switch (accountGroup) {
                case "realtime":
                    if (row) {
                        let rowData = row.data;
                        return await this.get_account_realtime(address, rowData["realtime"], chainList)
                    } else {
                        return await this.get_account_realtime(address, false, chainList)
                    }
                case "ss58h160":
                    let relatedData = false
                    if (row && row.data["related"] != undefined) {
                        relatedData = row.data["related"]
                    }
                    return await this.get_hashes_related(address, relatedData, "address")
                case "unfinalized":
                    //feed:extrinsicHash#chainID-extrinsicID
                    return await this.get_account_extrinsics_unfinalized(address, rows, maxRows, chainList, decorate, decorateExtra);
                case "extrinsics":
                    //feed:extrinsicHash#chainID-extrinsicID
                    return await this.get_account_extrinsics(address, rows, maxRows, chainList, decorate, decorateExtra, TSStart, pageIndex);
                case "transfers":
                    // need to also bring in "feedtransferunfinalized" from the same table
                    //feedtransfer:extrinsicHash#eventID
                    return await this.get_account_transfers(address, rows, maxRows, chainList, decorate, decorateExtra, TSStart, pageIndex);
                case "crowdloans":
                    //feedcrowdloan:extrinsicHash#eventID
                    return await this.get_account_crowdloans(address, rows, maxRows, chainList, decorate, decorateExtra, TSStart, pageIndex);
                case "rewards":
                    //feedreward:extrinsicHash#eventID
                    return await this.get_account_rewards(address, rows, maxRows, chainList, decorate, decorateExtra, TSStart, pageIndex);
                case "history":
                    let relatedExtrinsicsMap = {}
                    let hist = await this.get_account_history(address, rows, maxRows, chainList, false)
                    try {
                        //MK: history has family "history" but we are calling "feed" family here??
                        let [extrinsics] = await this.btAddressExtrinsic.getRows({
                            start: startRow,
                            end: address + "#" + paraTool.inverted_ts_key(hist.minTS) + "#ZZZ",
                            filter: [{
                                //family: families,
                                family: ["feed"],
                                cellLimit: 1
                            }],
                            limit: maxRows
                        });
                        if (extrinsics && extrinsics.length > 0) {
                            for (const ext of extrinsics) {
                                let [addressPiece, ts, extrinsicHashPiece] = paraTool.parse_addressExtrinsic_rowKey(ext.id)
                                let out = {};
                                let rowData = ext.data
                                if (rowData["feed"]) {
                                    let extrinsics = rowData["feed"];
                                    for (const extrinsicHashEventID of Object.keys(extrinsics)) {
                                        for (const cell of extrinsics[extrinsicHashEventID]) {
                                            let t = JSON.parse(cell.value);
                                            // here we copy just a FEW of the flds over for recognitions sake
                                            let flds = ["chainID", "blockNumber", "extrinsicHash", "extrinsicID", "section", "method"];
                                            for (const fld of flds) {
                                                if (t[fld] !== undefined) {
                                                    if (fld == "chainID" || fld == "blockNumber") {
                                                        out[fld] = parseInt(t[fld], 10); // can we avoid this step?
                                                    } else {
                                                        out[fld] = t[fld];
                                                    }

                                                }
                                            }
                                        }
                                    }
                                }
                                relatedExtrinsicsMap[ts] = out;
                            }
                        }
                    } catch (err) {
                        this.logger.error({
                            "op": "query.getAccount",
                            address,
                            accountGroup,
                            err
                        });
                    }
                    // console.log("*** relatedExtrinsicMap ** ", relatedExtrinsicsMap);
                    let out = [];
                    for (const assetChain of Object.keys(hist.data)) {
                        let h = hist.data[assetChain];
                        let states = hist.data[assetChain].states;
                        for (let i = 0; i < states.length; i++) {
                            // each of these is a pair [indexTS, state] ... but we can push a POTENTIAL extrinsicHash IF they happen to be the SAME ts
                            if (states[i].length == 2) {
                                let [indexTS, _] = states[i];
                                if (relatedExtrinsicsMap[indexTS] !== undefined) {
                                    states[i].push(this.clean_extrinsic_object(relatedExtrinsicsMap[indexTS]));
                                }
                            }
                        }
                        out.push(h);
                    }
                    return {
                        data: out,
                            nextPage: hist.nextPage
                    };
                case "balances":
                    let historyObj = await this.get_account_history(address, rows, maxRows, chainList, true);
                    let h = historyObj.data
                    let balances = [];
                    let currentTS = this.currentTS();
                    let startTS = currentTS - 86400 * lookback;
                    for (let ts = startTS; ts <= currentTS; ts += 86400) {

                        let totalUSDVal = 0;
                        for (const assetChain of Object.keys(h)) {
                            let assetInfo = this.assetInfo[assetChain];
                            if (assetInfo !== undefined) {
                                let assetType = assetInfo.assetType;
                                let chainID = assetInfo.chainID;
                                let flds = this.get_assetType_flds(assetType);
                                let states = h[assetChain].states; // each of these is a pair [indexTS, state]
                                let state = false;
                                for (let i = 0; i < states.length; i++) {
                                    if (states[i].length == 2) {
                                        let [indexTS, stateAt] = states[i];
                                        if (ts >= indexTS && (state == false)) {
                                            state = stateAt;
                                            // can we break here?
                                        }
                                    }
                                }
                                if (state) {
                                    let USDval = await this.decorate_assetState(assetInfo, state, flds, ts);
                                    totalUSDVal += USDval
                                }
                            } else {
                                console.log("failed to find: ", assetChain);
                            }
                        }

                        balances.push([ts * 1000, totalUSDVal]);
                    }
                    return (balances);
                default:
                    return false;
                    break;
            }
        } catch (err) {
            if (err instanceof paraTool.InvalidError || err instanceof paraTool.NotFoundError) {
                throw err
            }
            console.log(err);
            this.logger.error({
                "op": "query.getAccount",
                address,
                accountGroup,
                err
            });
            return {};
        }
    }

    validAddress(address) {
        if (!address) return false;
        if (address.length == 66) return true;
        if (address.length == 42) return true;
        return false;
    }

    async getRealtimeAsset(rawAddress) {
        const maxRows = 1000;
        let address = paraTool.getPubKey(rawAddress)
        if (!this.validAddress(address)) {
            throw new paraTool.InvalidError(`Invalid address ${address}`)
        }
        var hrstart = process.hrtime()
        try {
            let [tblName, tblRealtime] = this.get_btTableRealtime()
            const filter = [{
                column: {
                    cellLimit: 1
                },
                families: [
                    "realtime"
                ],
                limit: maxRows
            }];
            const [row] = await this.tblRealtime.row(address).get({
                filter
            });

            let rowData = row.data;
            let account = {};
            const realtimeData = rowData["realtime"];
            let realtime = {};
            if (realtimeData) {
                for (const assetChainEncoded of Object.keys(realtimeData)) {
                    let cell = realtimeData[assetChainEncoded];
                    let assetChain = paraTool.decodeAssetChain(assetChainEncoded);
                    let [asset, chainID] = paraTool.parseAssetChain(assetChain);
                    if (chainID !== undefined) {
                        try {
                            let assetInfo = this.assetInfo[assetChain];
                            if (assetInfo == undefined) {
                                // console.log("NO ASSETINFO", assetChain, "asset", asset, "chainID", chainID, cell[0].value);
                            } else {
                                let assetType = assetInfo.assetType;
                                if (realtime[assetType] == undefined) {
                                    realtime[assetType] = [];
                                }
                                realtime[assetType].push({
                                    assetInfo,
                                    state: JSON.parse(cell[0].value)
                                });
                            }
                        } catch (err) {
                            console.log("REALTIME ERR", err);
                        }
                    }
                }
            }
            await this.compute_holdings_USD(realtime);
            return (realtime);
        } catch (err) {
            if (err.code == 404) {
                throw Error("Account not found");
            }
            this.logger.error({
                "op": "query.getRealtimeAsset",
                address,
                err
            });
        }
        return (false);
    }

    decorateEventModule(evt, decorate = true, decorateData = true) {
        try {
            let [section, method] = paraTool.parseSectionMethod(evt)
            let nEvent = {}
            nEvent.eventID = evt.eventID
            if (decorate && decorateData) nEvent.docs = evt.docs
            nEvent.section = evt.section
            nEvent.method = evt.method
            nEvent.data = evt.data
            if (decorate && decorateData) nEvent.dataType = evt.dataType // returning dataType for now?
            return nEvent
        } catch (err) {
            this.logger.error({
                "op": "query.decorateEventModule",
                evt,
                err
            });
        }
    }

    async decorateParams(section, method, args, chainID, ts, depth = 0, decorate = true, decorateExtra = ["data", "address", "usd"]) {
        this.chainParserInit(chainID, this.debugLevel);
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        try {
            if (section == 'ethereum' && method == 'transact') {
                if (args.transaction != undefined) {
                    let evmTx = false;
                    if (args.transaction.eip1559 != undefined) {
                        evmTx = args.transaction.eip1559
                    } else if (args.transaction.legacy != undefined) {
                        evmTx = args.transaction.legacy
                    }
                    console.log(`evmTx`, evmTx)
                    if (decorate && evmTx) {
                        let output = ethTool.decodeTransactionInput(evmTx, this.contractABIs, this.contractABISignatures)
                        console.log(`output`, output)
                        if (output != undefined) {
                            args.decodedEvmInput = output
                        }
                    }
                }
            }
            if (args.other_signatories != undefined) {
                if (decorate) this.decorateAddresses(args, "other_signatories", decorateAddr, false) // ignore here?
            }
            if (args.real != undefined) {
                let address = paraTool.getPubKey(args.real)
                if (address) {
                    args.realAddress = address
                    if (decorate) this.decorateAddress(args, "realAddress", decorateAddr, false)
                }
            }
            if (args.calls != undefined) { // this is an array
                //console.log(depth, "descend into calls", args.calls.length)
                let i = 0;
                for (const c of args.calls) {
                    let call_section = c.section;
                    let call_method = c.method;
                    //console.log(depth, "call ", i , call_section, call_method, c);
                    i++;
                    await this.decorateParams(call_section, call_method, c.args, chainID, ts, depth + 1, decorate, decorateExtra)
                }
            } else if (args.call != undefined) { // this is an object
                let call = args.call
                let call_section = call.section;
                let call_method = call.method;
                //console.log(depth, "descend into call", call)
                await this.decorateParams(call_section, call_method, call.args, chainID, ts, depth + 1, decorate, decorateExtra)
            } else {
                let pallet_method = `${section}:${method}`
                //console.log(depth, "leaf", pallet_method, args)
                await this.chainParser.decorate_query_params(this, pallet_method, args, chainID, ts, 0, decorate, decorateExtra)
            }
        } catch (err) {
            this.logger.error({
                "op": "query.decorateParams",
                section,
                method,
                args,
                chainID,
                err
            });
        }
    }

    async decorateExtrinsic(ext, chainID, status = "", decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        if (typeof chainID == "string") {
            chainID = parseInt(chainID, 10);
        }
        //console.log(`decorateExtrinsic [${ext.extrinsicID}] decorateData=${decorateData} decorateAddr=${decorateAddr} decorateUSD=${decorateUSD} decorateRelated=${decorateRelated}`)
        let decoratedExt = {
            chainID: chainID,
            id: null,
            chainName: this.getChainName(ext.chainID),
            extrinsicHash: ext.extrinsicHash,
            extrinsicID: ext.extrinsicID,
            blockNumber: ext.blockNumber,
            ts: ext.ts,
            blockHash: ext.blockHash,
        }

        try {
            if (ext.signer != undefined && ext.signer != 'NONE') {
                let signer = ext.signer
                let fromAddress = paraTool.getPubKey(signer)
                //console.log(`decorateExtrinsic [${ext.extrinsicID}] [decorate=${decorate}], signer=${signer}, fromAddress=${fromAddress}`)
                decoratedExt.signer = signer
                decoratedExt.fromAddress = fromAddress
                //console.log(`decoratedExt before decorateAddress [decorate=${decorate}, decorateAddr=${decorateAddr},decorateRelated=${decorateRelated}]`, decoratedExt)
                if (decorate) this.decorateAddress(decoratedExt, "fromAddress", decorateAddr, decorateRelated)
                //console.log(`decoratedExt after decorateAddress  [decorate=${decorate}, decorateAddr=${decorateAddr},decorateRelated=${decorateRelated}]`, decoratedExt)
            } else {
                //console.log(`decorateExtrinsic ext.signer not ok [${ext.extrinsicID}]`, ext.signer)
            }

            if (ext.evm != undefined) {
                decoratedExt.evm = ext.evm
            }
            if (ext.signature) {
                decoratedExt.signature = ext.signature
            }
            if (ext.lifetime) {
                decoratedExt.lifetime = ext.lifetime
            }

            [decoratedExt.chainID, decoratedExt.id] = this.convertChainID(decoratedExt.chainID)

            decoratedExt.nonce = ext.nonce
            decoratedExt.tip = ext.tip
            decoratedExt.fee = ext.fee
            //console.log(`decoratedExt before fee [decorate=${decorate}, decorateUSD=${decorateUSD}]`, decoratedExt)
            if (ext.fee > 0) {
                await this.decorateFee(decoratedExt, decoratedExt.chainID, decorateUSD)
            }
            decoratedExt.result = ext.result
            //console.log(`decoratedExt after fee [decorate=${decorate}, decorateUSD=${decorateUSD}]`, decoratedExt)
            if (ext.err != undefined) decoratedExt.err = ext.err
            if (status != "") decoratedExt.status = status;
            if (ext.genTS) decoratedExt.genTS = decoratedExt.genTS
            if (ext.source) decoratedExt.source = decoratedExt.source

            let [section, method] = paraTool.parseSectionMethod(ext)
            decoratedExt.section = section
            decoratedExt.method = method
            decoratedExt.params = ext.params

            if (ext.events != undefined) {
                decoratedExt.events = []
                for (const evt of ext.events) {
                    let dEvent = this.decorateEventModule(evt, decorate, decorateData)
                    decoratedExt.events.push(dEvent)
                }
            }
            //console.log(`decoratedExt after decorateEventModule [decorate=${decorate}, decorateUSD=${decorateUSD}]`, decoratedExt)
            if (ext.params != undefined && decorate) {
                this.decorateParams(section, method, ext.params, chainID, ext.ts, 0, decorate, decorateData)
            }
            //console.log(`decoratedExt after decorateParams [decorate=${decorate}, decorateUSD=${decorateUSD}]`, decoratedExt)
        } catch (err) {
            console.log(`decorateExtrinsic err`, err.toString())
            this.logger.error({
                "op": "query.decorateExtrinsic",
                ext,
                chainID,
                ts,
                err
            });
        }

        //decoratedExt.chainName = this.getChainName(chainID)
        return decoratedExt
    }

    async decorateFee(extrinsic, chainID, decorateUSD = true) {
        try {
            var chainSymbol = this.getChainSymbol(chainID)
            var chainDecimals = this.getChainDecimal(chainID)
            var fee = (extrinsic.fee != undefined) ? (extrinsic.fee) : 0
            var tip = (extrinsic.tip != undefined) ? (extrinsic.tip) : 0
            var targetAsset = `{"Token":"${chainSymbol}"}`
            if (decorateUSD) {
                var [balanceUSDFee, priceUSD, priceUSDCurrent] = await this.computeUSD(fee, targetAsset, chainID, extrinsic.ts);
                var [balanceUSDTip, _, __] = await this.computeUSD(tip, targetAsset, chainID, extrinsic.ts);
                extrinsic.chainSymbol = chainSymbol
                if (balanceUSDFee) extrinsic.feeUSD = balanceUSDFee
                if (balanceUSDTip) extrinsic.tipUSD = balanceUSDTip
                if (priceUSD) extrinsic.priceUSD = priceUSD
                if (priceUSDCurrent) extrinsic.priceUSDCurrent = priceUSDCurrent
            } else {
                extrinsic.chainSymbol = chainSymbol
            }
        } catch (err) {
            this.logger.error({
                "op": "query.decorateFee",
                extrinsic,
                chainID,
                err
            });

        }
    }

    async decorateEvent(event, chainID, ts, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        if (!decorate || !decorateData) return event

        let dEvent = event
        let decodedData = this.mergeEventDataAndDataType(event.data, event.dataType, decorate, decorateExtra)

        let [pallet, method] = paraTool.parseSectionMethod(event)
        let pallet_method = `${pallet}:${method}`

        switch (pallet_method) {

            case "treasury:Awarded": //balance, accountID
            case "treasury:Burnt": //bal
            case "treasury:Deposit": //bal
            case "treasury:Proposed": //ProposalIndex
            case "treasury:Rejected": //ProposalIndex, bal
            case "treasury:Rollover": //bal
            case "treasury:Spending": //bal

            case "balances:BalanceSet": //
            case "balances:Deposit":
            case "balances:DustLost":
            case "balances:Endowed":
            case "balances:ReserveRepatriated":
            case "balances:Reserved":
            case "balances:Slashed":
            case "balances:Transfer":
            case "balances:Unreserved":
            case "balances:Withdraw":

                let exceptionList = ["balances:BalanceSet", "balances:ReserveRepatriated", "treasury:Awarded", "treasury:Proposed", "treasury:Rejected"]
                let idxs = []
                //some balance events have different inputs (i.e. BalanceSet, ReserveRepatriated, Awarded, Proposed, Rejected)
                if (exceptionList.includes(pallet_method)) {
                    if (pallet_method == "balances:BalanceSet") {
                        idxs.push(event.data.length - 1)
                        idxs.push(event.data.length - 2)
                    }
                    if (pallet_method == "balances:ReserveRepatriated") {
                        //status is the last input
                        idxs.push(event.data.length - 2)
                    }
                    if (pallet_method == "treasury:Awarded") {
                        idxs.push(event.data.length - 2)
                    }
                    if (pallet_method == "treasury:Proposed") {
                        //TODO: how to process ProposalIndex?
                    }
                    if (pallet_method == "treasury:Rejected") {
                        //TODO: how to process ProposalIndex?
                        idxs.push(event.data.length - 1)
                    }

                } else {
                    // bal is ususally the last input
                    idxs.push(event.data.length - 1)
                }

                var chainSymbol = this.getChainSymbol(chainID)
                var chainDecimals = this.getChainDecimal(chainID)
                var targetAsset = `{"Token":"${chainSymbol}"}`
                //console.log("targetAsset", targetAsset)
                for (const idx of idxs) {
                    var bal = paraTool.dechexToInt(event.data[idx])
                    if (paraTool.isFloat(bal)) {
                        // already float
                    } else if (paraTool.isInt(bal)) {
                        bal = bal / 10 ** chainDecimals // always get here
                    }
                    if (decorateUSD) {
                        var [balanceUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(bal, targetAsset, chainID, ts)
                        decodedData[idx].symbol = chainSymbol
                        decodedData[idx].dataRaw = bal
                        if (balanceUSD) {
                            decodedData[idx].dataUSD = balanceUSD
                            decodedData[idx].priceUSD = priceUSD
                            decodedData[idx].priceUSDCurrent = priceUSDCurrent
                        }
                    } else {
                        decodedData[idx].symbol = chainSymbol
                        decodedData[idx].dataRaw = bal
                    }
                }
                break;

            case "crowdloan:Contributed": //accountID, paraID, balance
            {
                let paraInfo = this.getParaInfo(event.data[1], chainID)
                decodedData[1].projectName = paraInfo.name
                decodedData[1].relayChain = paraInfo.relayChain
                var chainSymbol = this.getChainSymbol(chainID)
                var chainDecimals = this.getChainDecimal(chainID)
                var targetAsset = `{"Token":"${chainSymbol}"}`
                var bal = paraTool.dechexToInt(event.data[2])

                if (paraTool.isFloat(bal)) {
                    // already float
                } else if (paraTool.isInt(bal)) {
                    bal = bal / 10 ** chainDecimals // always get here
                }
                if (decorateUSD) {
                    var [balanceUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(bal, targetAsset, chainID, ts)
                    decodedData[2].symbol = chainSymbol
                    decodedData[2].dataRaw = bal
                    if (balanceUSD) {
                        decodedData[2].dataUSD = balanceUSD
                        decodedData[2].priceUSD = priceUSD
                        decodedData[2].priceUSDCurrent = priceUSDCurrent
                    }
                } else {
                    decodedData[2].symbol = chainSymbol
                    decodedData[2].dataRaw = bal
                }

            }
            break;

            case "crowdloan:Contributed": //accountID, paraID, balance
            {
                let paraInfo = this.getParaInfo(event.data[1], chainID)
                decodedData[1].projectName = paraInfo.name
                decodedData[1].relayChain = paraInfo.relayChain
                var chainSymbol = this.getChainSymbol(chainID)
                var chainDecimals = this.getChainDecimal(chainID)
                var targetAsset = `{"Token":"${chainSymbol}"}`
                var bal = paraTool.dechexToInt(event.data[2])

                if (paraTool.isFloat(bal)) {
                    // already float
                } else if (paraTool.isInt(bal)) {
                    bal = bal / 10 ** chainDecimals // always get here
                }

                if (decorateUSD) {
                    let [balanceUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(bal, targetAsset, chainID, ts)
                    decodedData[2].symbol = chainSymbol
                    decodedData[2].dataRaw = bal
                    if (balanceUSD) {
                        decodedData[2].dataUSD = balanceUSD
                        decodedData[2].priceUSD = priceUSD
                        decodedData[2].priceUSDCurrent = priceUSDCurrent
                    }
                } else {
                    decodedData[idx].symbol = chainSymbol
                    decodedData[idx].dataRaw = bal
                }
            }
            break;
        }
        if (decorateData) dEvent.decodedData = decodedData
        return dEvent
    }

    async decorateQueryFeedTransfer(feedtransfer, chainID, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        /*
          FeedTransfer contains asset other than native token. must use asset/rawAsset instead
                */
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        var rawBal = feedtransfer.rawAmount
        var bal = feedtransfer.amount
        if (feedtransfer.amount == undefined) {
            var chainDecimals = this.getChainDecimal(chainID)
            bal = feedtransfer.rawAmount / 10 ** chainDecimals //use native chain decimals to process unknown asset
        }
        var aseetSymbol = null;
        if (feedtransfer.symbol != undefined) {
            aseetSymbol = feedtransfer.symbol
        }

        let res = {
            symbol: aseetSymbol,
            dataRaw: bal,
        }

        if (decorateUSD) {
            var targetAsset = feedtransfer.asset
            let [balanceUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(bal, targetAsset, chainID, feedtransfer.ts)
            if (!priceUSD && feedtransfer.decimals != undefined) {
                //computeUSD failed with asset
                //let alternativeAsset = `{"Token":"${feedtransfer.rawAsset}"}`
                var alternativeAsset = `${feedtransfer.rawAsset}`
                //console.log(`fallback alternativeAsset = ${alternativeAsset}`)
                let [balanceUSD2, priceUSD2, priceUSDCurrent2] = await this.computeUSD(bal, alternativeAsset, chainID, feedtransfer.ts)
                if (priceUSD2 > 0) {
                    //console.log(`[sucess] decorateQueryFeedTransfer alternativeAsset=${alternativeAsset}`)
                    balanceUSD = balanceUSD2
                    priceUSD = priceUSD2
                    priceUSDCurrent = priceUSDCurrent2
                }
            }

            if (balanceUSD) {
                res.dataUSD = balanceUSD
                res.priceUSD = priceUSD
                res.priceUSDCurrent = priceUSDCurrent
            }
        }


        let dFeedtransfer = {
            chainID: feedtransfer.chainID,
            chainName: feedtransfer.chainName,
            id: feedtransfer.id,
            blockNumber: feedtransfer.blockNumber,
            blockHash: feedtransfer.blockHash,
            ts: feedtransfer.ts,
            transferType: null,
            eventID: feedtransfer.eventID,
            section: feedtransfer.section,
            method: feedtransfer.method,
            extrinsicID: feedtransfer.extrinsicID,
            extrinsicHash: feedtransfer.extrinsicHash,
            from: feedtransfer.from,
            to: feedtransfer.to,
        }

        if (feedtransfer.isIncoming != undefined) {
            if (feedtransfer.isIncoming == 1) {
                dFeedtransfer.transferType = 'incoming'
            } else {
                dFeedtransfer.transferType = 'outgoing'
            }
        }
        if (dFeedtransfer.from != undefined) {
            dFeedtransfer.fromAddress = paraTool.getPubKey(dFeedtransfer.from)
            if (decorate) this.decorateAddress(dFeedtransfer, "fromAddress", decorateAddr, decorateRelated)
        }
        if (dFeedtransfer.to != undefined) {
            dFeedtransfer.toAddress = paraTool.getPubKey(dFeedtransfer.to)
            if (decorate) this.decorateAddress(dFeedtransfer, "toAddress", decorateAddr, decorateRelated)
        }

        dFeedtransfer.rawAsset = feedtransfer.rawAsset
        dFeedtransfer.rawAmount = feedtransfer.rawAmount
        if (decorateUSD) dFeedtransfer.amountUSD = (feedtransfer.amountUSD != undefined) ? feedtransfer.amountUSD : 0
        dFeedtransfer.decimals = (feedtransfer.decimals != undefined) ? feedtransfer.decimals : null // unknown case
        dFeedtransfer.data = feedtransfer.data
        if (decorateData) dFeedtransfer.decodedData = res
        return dFeedtransfer
    }

    mergeEventDataAndDataType(data, dataType, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let dd = []
        for (var i = 0; i < data.length; i++) {
            let d = data[i]
            let dt = dataType[i]
            let x = {
                data: d,
                typeDef: dt.typeDef,
                name: dt.name
            }
            if (x.typeDef == "AccountId32") {
                x.address = paraTool.getPubKey(d)
                if (decorate) {
                    this.decorateAddress(x, "address", decorateAddr, decorateRelated)
                }
            }
            dd.push(x)
        }
        return dd
    }

    // input: 1642608001
    // output: 1642608000
    hourly_key_from_ts(ts) {
        let out = Math.round(ts / 3600) * 3600;
        return (out.toString());
    }

    async searchXCMTransfers(filters = {}, limit = 1000, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let w = [];
        for (const filt of Object.keys(filters)) {
            let v = filters[filt]
            switch (filt.toLowerCase()) {
                case "blocknumberstart":
                case "blockstart":
                case "startblock":
                    w.push(`blockNumber >= ${v}`);
                    break;
                case "endblock":
                case "blockend":
                case "blocknumberend":
                    w.push(`blockNumber <= ${v}`);
                    break;
                case "section":
                    w.push(`lower(p) = lower('${v}')`);
                    break;
                case "method":
                    w.push(`lower(m) = lower('${v}')`);
                    break;
                case "fromaddress":
                    let fromAddress = paraTool.getPubKey(v);
                    w.push(`fromAddress = '${fromAddress}'`);
                    break;
                case "toaddress":
                    let destAddress = paraTool.getPubKey(v);
                    w.push(`destAddress = '${destAddress}'`);
                    break;
                case "complete":
                    let complete = (parseInt(v) > 0) ? 0 : 1;
                    w.push(`incomplete = '${complete}'`);
                    break;
                case "datestart":
                case "startdate":
                    w.push(`Date(FROM_UNIXTIME(sourceTS)) >= '${v}'`);
                    break;
                case "dateend":
                case "enddate":
                    w.push(`Date(FROM_UNIXTIME(sourceTS)) <= '${v}'`);
                    break;
                case "result":
                    let result = v > 0
                    w.push(`incomplete = ${result}`);
                    break;
                case "chainid":
                case "chainidentifier":
                    let [chainID, id] = this.convertChainID(v)
                    if (chainID !== false) {
                        w.push(`chainID = ${chainID}`);
                    } else {
                        throw new Error(`invalid chainIdentifier: ${v}`);
                    }
                    break;
                case "chainiddest":
                case "chainidentifierdest":
                    let [chainIDDest, id2] = this.convertChainID(v)
                    if (chainIDDest !== false) {
                        w.push(`chainIDDest = ${chainIDDest}`);
                    } else {
                        throw new Error(`invalid chainIdentifierDest: ${v}`);
                    }
                    break;
                default:
                    throw new Error(`XCM Transfers invalid filter: ${filt}`);
            }
        }
        let wstr = w.join(" and ")
        if (w.length > 0) {
            wstr = " WHERE " + wstr
        }
        let sql = `select msgHash, extrinsicHash, extrinsicID, chainID, chainIDDest, blockNumber, fromAddress, destAddress, sectionMethod, asset, rawAsset, nativeAssetChain, blockNumberDest, sourceTS, destTS, amountSent, amountReceived, status, relayChain, incomplete, amountSentUSD, amountReceivedUSD from xcmtransfer ${wstr} order by sourceTS desc limit ${limit}`
        let xcmtransfers = await this.poolREADONLY.query(sql);
        let out = [];
        for (let i = 0; i < xcmtransfers.length; i++) {
            // TODO: abstract the { asset, rawAsset, nativeAssetChain } dataset out of xcmtransfers table and use computeUSD / getDecimals to do the work rather than this being in 4 places that are solely xcmtransfers related:  -- the rawAsset/nativeAssetChain => asset mappings should be in another table!
            let x = xcmtransfers[i];
            try {
                x.asset = this.trimquote(x.asset); // temporary hack
                if (x.asset.includes("Token")) {
                    let decimals = false;
                    let targetChainID = x.chainID // the chainID to use for price lookup
                    let targetAsset = x.rawAsset // the asset to use for price lookup

                    if (x.nativeAssetChain != undefined) {
                        let [nativeAsset, nativeChainID] = paraTool.parseAssetChain(x.nativeAssetChain)
                        targetAsset = nativeAsset
                        targetChainID = nativeChainID
                    }
                    if (decorate) {
                        this.decorateAddress(x, "fromAddress", decorateAddr, decorateRelated)
                        this.decorateAddress(x, "destAddress", decorateAddr, decorateRelated)
                    }
                    let rawassetChain = paraTool.makeAssetChain(targetAsset, targetChainID);
                    if (this.assetInfo[rawassetChain] && this.assetInfo[rawassetChain].decimals != undefined) {
                        decimals = this.assetInfo[rawassetChain].decimals;
                    }

                    if (x.msgHash == undefined) x.msgHash = '0x'

                    if (this.assetInfo[rawassetChain]) {
                        if (decimals !== false) {
                            let amountSent = (x.amountSent != undefined) ? x.amountSent / 10 ** decimals : 0
                            let amountReceived = (x.amountReceived != undefined) ? x.amountReceived / 10 ** decimals : 0;
                            x.amountSent = amountSent
                            x.amountReceived = amountReceived
                            let [_, id] = this.convertChainID(x.chainID)
                            x.chainName = this.getChainName(x.chainID);
                            let [__, idDest] = this.convertChainID(x.chainIDDest)
                            x.id = id
                            x.idDest = idDest
                            x.chainDestName = this.getChainName(x.chainIDDest);
                            out.push(x);
                        }
                    }
                }
            } catch (e) {
                this.logger.error({
                    "op": "query.searchXCMTransfers",
                    x,
                    err
                });
            }
        }
        return out;
    }

    async getExtrinsics(query = {}, limit = 1000, decorate = true, decorateExtra = true) {
        return this.bq_query("extrinsics", query, limit, decorate, decorateExtra);
    }

    async getTransfers(query = {}, limit = 1000, decorate = true, decorateExtra = true) {
        return this.bq_query("transfers", query, limit, decorate, decorateExtra);
    }

    async getEvents(query = {}, limit = 1000, decorate = true, decorateExtra = true) {
        return this.bq_query("events", query, limit, decorate, decorateExtra);
    }

    async getEVMTxs(query = {}, limit = 1000, decorate = true, decorateExtra = true) {
        return this.bq_query_evmtxs("evmtxs", query, limit, decorate, decorateExtra);
    }

    async bq_query(tbl = "extrinsics", filters = {}, limit = 1000, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {

        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

        const bigqueryClient = new BigQuery();
        let fullTable = this.getBQTable(tbl);

        let flds = "c as chainID, bn as blockNumber, id as eventID, h as extrinsicHash, p as section, m as method, UNIX_SECONDS(ts) as blockTS";
        let fldsmysql = "";
        if (tbl == "extrinsics") {
            flds = "c as chainID, bn as blockNumber, id as extrinsicID, h as extrinsicHash, p as section, m as method, f as fromAddress, UNIX_SECONDS(ts) as blockTS, r as result";
            fldsmysql = "chainID, blockNumber, extrinsicID, extrinsicHash, section, method, fromAddress, ts as blockTS, result"
        } else if (tbl == "transfers") {
            flds = "c as chainID, bn as blockNumber, id as extrinsicID, h as extrinsicHash, p as section, m as method, f as fromAddress, t as toAddress, asset, symbol, priceUSD, a as amount, v as amountUSD, UNIX_SECONDS(ts) as blockTS";
            fldsmysql = "chainID, blockNumber, extrinsicID, extrinsicHash, section, method, fromAddress, toAddress, asset, symbol, priceUSD, amount, amountUSD, ts as blockTS"
        }
        let w = [];
        let wr = [];
        let recent = (tbl == "extrinsics" || tbl == "transfers"); // TODO: if date filter is used, set recent = false
        for (const filt of Object.keys(filters)) {
            let v = filters[filt]
            switch (filt.toLowerCase()) {
                case "blocknumberstart":
                case "blockstart":
                case "startblock":
                    w.push(`bn >= ${v}`);
                    if (recent) wr.push(`blockNumber >= '${v}'`)
                    break;
                case "endblock":
                case "blockend":
                case "blocknumberend":
                    w.push(`bn <= ${v}`);
                    if (recent) wr.push(`blockNumber <= '${v}'`)
                    break;
                case "section":
                    w.push(`lower(p) = lower('${v}')`);
                    if (recent) wr.push(`LOWER(section) = LOWER('${v}')`)
                    break;
                case "method":
                    w.push(`lower(m) = lower('${v}')`);
                    if (recent) wr.push(`LOWER(method) = LOWER('${v}')`)
                    break;
                case "fromaddress":
                    let fromAddress = paraTool.getPubKey(v);
                    w.push(`f = '${fromAddress}'`);
                    if (recent) wr.push(`fromAddress = '${v}'`)
                    break;
                case "symbol": // transfers only
                    if (tbl == "transfers") {
                        w.push(`symbol = '${v}'`);
                        if (recent) wr.push(`symbol = '${v}'`)
                    }
                    break;
                case "toaddress": // transfers only
                    if (tbl == "transfers") {
                        let toAddress = paraTool.getPubKey(v);
                        w.push(`t = '${toAddress}'`);
                        if (recent) wr.push(`toAddress = '${v}'`)
                    }
                    break;
                case "symbol": // transfers only
                    if (tbl == "transfers") w.push(`symbol = '${symbol}'`);
                    break;
                case "toaddress": // transfers only
                    let toAddress = paraTool.getPubKey(v);
                    w.push(`t = '${toAddress}'`);
                    break;
                case "datestart":
                case "startdate":
                    w.push(`Date(ts) >= '${v}'`);
                    if (recent) wr.push(`logDT >= '${v}'`)
                    break;
                case "dateend":
                case "enddate":
                    w.push(`Date(ts) <= '${v}'`);
                    if (recent) wr.push(`logDT <= '${v}'`)
                    break;
                case "result":
                    if (tbl == "extrinsics") {
                        w.push(`r = ${v}`);
                        if (recent) wr.push(`result = '${v}'`)
                    }
                    break;
                case "signed":
                    if (tbl == "extrinsics") {
                        w.push(`s = ${v}`);
                        if (recent) wr.push(`signed = '${v}'`)
                    }
                    break;
                case "chainid":
                case "chainidentifier":
                    let [chainID, id] = this.convertChainID(v)
                    if (chainID !== false) {
                        w.push(`c = ${chainID}`);
                        if (recent) wr.push(`chainID = ${chainID}`)
                    } else {
                        throw new Error(`invalid chainIdentifier: ${v}`);
                    }
                    break;
                default:
                    throw new Error(`invalid filter: ${filt}`);
            }
        }
        let sqlQuery = ``;
        if (w.length == 0) w.push(`ts > 0`)
        if (w.length > 0) {
            sqlQuery = `SELECT ${flds} FROM ${fullTable} WHERE ` + w.join(" and ") + ` ORDER By ts desc LIMIT ${limit}`;
        }

        const options = {
            query: sqlQuery,
            // Location must match that of the dataset(s) referenced in the query.
            location: 'US',
        };

        try {
            let rows = null;
            if (limit <= 1000) {
                // typical  "simple" case: Add rows from bigquery
                [rows] = await bigqueryClient.query(options);
            } else {
                // Run the query as a job
                const [job] = await bigqueryClient.createQueryJob(options);
                await job.getQueryResults();
                [rows] = await job.getQueryResults();
            }
            let keys = {}
            if (recent) {
                for (let i = 0; i < rows.length; i++) {
                    if ((tbl == "extrinsics") || (tbl == "transfers")) {
                        let r = rows[i];
                        keys[r.extrinsicID] = true;
                        if (r.ts != undefined && r.ts.value != undefined) {
                            r.ts = r.ts.value;
                        }
                    }
                }
            }
            // Add rows from mysql "recent" table
            let numRecents = 0;
            if (recent && fldsmysql.length > 0) {
                let mysqlQuery = `SELECT ${fldsmysql} FROM ${tbl}recent WHERE ` + wr.join(" and ") + ` LIMIT ${limit}`;
                let recs = await this.poolREADONLY.query(mysqlQuery);
                for (let i = 0; i < recs.length; i++) {
                    let r = recs[i];
                    if (tbl == "extrinsics" && keys[r.extrinsicID] !== undefined) {

                    } else if (tbl == "transfers" && keys[r.extrinsicID] !== undefined) {

                    } else {
                        numRecents++;
                        rows.push(r);
                    }
                }
            }
            // for both datasets, augment chainName, ts,
            for (let i = 0; i < rows.length; i++) {
                let r = rows[i];
                if (r.chainName == undefined && r.chainID != undefined) {
                    r.chainName = this.getChainName(r.chainID);
                }
                if (decorate) {
                    if (r.fromAddress != undefined) {
                        this.decorateAddress(r, "fromAddress", decorateAddr, decorateRelated);
                    }
                    if (r.toAddress != undefined) {
                        this.decorateAddress(r, "toAddress", decorateAddr, decorateRelated);
                    }
                }
                if (rows.length > limit) {
                    rows = rows.slice(0, limit); // CHECK
                }

                // sort by ts descending, if we had recent recs
                if (numRecents > 0) {

                    rows.sort(function(a, b) {
                        let bTS = (b.blockTS !== undefined) ? b.blockTS : 0;
                        let aTS = (a.blockTS !== undefined) ? a.blockTS : 0;
                        return (bTS - aTS);
                    })
                }
            }
            return (rows);
        } catch (err) {
            this.logger.error({
                "op": "query.bq_query",
                err,
                sqlQuery,
                filters
            });
            throw new Error(`An error has occurred.`);
        }
    }

    async bq_query_evmtxs(tbl = "evmtxs", filters = {}, limit = 100, decorate = true, decorateExtra = ["data", "address", "usd", "related"]) {

        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)

        const bigqueryClient = new BigQuery();
        let fullTable = this.getBQTable(tbl);

        let flds = "c as chainID, bn as blockNumber, h as transactionHash, s as method, m as methodID, UNIX_SECONDS(ts) as blockTS, r as result, f as fromAddress, t as toAddress, substrate, cr as creates";

        let w = [];
        for (const filt of Object.keys(filters)) {
            let v = filters[filt]
            switch (filt.toLowerCase()) {
                case "blocknumberstart":
                case "blockstart":
                case "startblock":
                    w.push(`bn >= ${v}`);
                    break;
                case "endblock":
                case "blockend":
                case "blocknumberend":
                    w.push(`bn <= ${v}`);
                    break;
                case "method": // label is "Method"
                    v = v.toLowerCase()
                    w.push(`lower(s) like '%${v}%'`);
                    break;
                case "methodid":
                    w.push(`lower(m) = lower('${v}')`);
                    break;
                case "fromaddress":
                    let fromAddress = v.toLowerCase();
                    w.push(`lower(f) = '${fromAddress}'`);
                    break;
                case "toaddress":
                    let toAddress = v.toLowerCase();
                    w.push(`lower(t) = '${toAddress}'`);
                    break;
                case "creates":
                    let creates = parseInt(v);
                    if (creates > 0) {
                        w.push(`cr is Not Null`);
                    } else {
                        w.push(`cr is Null`);
                    }
                    break;
                case "datestart":
                case "startdate":
                    w.push(`Date(ts) >= '${v}'`);
                    break;
                case "dateend":
                case "enddate":
                    w.push(`Date(ts) <= '${v}'`);
                    break;
                case "result":
                    w.push(`r = ${v}`);
                    break;
                case "chainid":
                case "chainidentifier":
                    let [chainID, id] = this.convertChainID(v)
                    if (chainID !== false) {
                        w.push(`c = ${chainID}`);
                    } else {
                        throw new Error(`invalid chainIdentifier: ${v}`);
                    }
                    break;
                default:
                    throw new Error(`invalid filter: ${filt}`);
            }
        }
        let sqlQuery = ``;
        if (w.length > 0) {
            sqlQuery = `SELECT ${flds}
       FROM ${fullTable}
       WHERE ` + w.join(" and ") + `
       ORDER By ts desc LIMIT ${limit}`;
        }
        const options = {
            query: sqlQuery,
            // Location must match that of the dataset(s) referenced in the query.
            location: 'US',
        };

        try {
            // Run the query
            const [rows] = await bigqueryClient.query(options);
            for (let i = 0; i < rows.length; i++) {
                let r = rows[i];
                if (decorate) {
                    if (r.fromAddress != null) {
                        this.decorateAddress(r, "fromAddress", decorateAddr, decorateRelated)
                    }
                }
            }
            return (rows);
        } catch (err) {
            this.logger.error({
                "op": "query.bq_query",
                err,
                filters
            });
            throw new Error("An error has occurred.")
        }

    }

    async getRecentXCMMessages(filters, limit, decorate, decorateExtra) {
        let chainList = (filters.chainList != undefined) ? filters.chainList : [];
        let blockNumber = (filters.blockNumber != undefined) ? filters.blockNumber : null;
        let beneficiaries = (filters.beneficiaries != undefined) ? filters.beneficiaries : null;
        let chainListFilter = "";
        if (chainList.length > 0) {
            chainListFilter = ` and ( chainID in ( ${chainList.join(",")} ) or chainIDDest = ${chainList.join(",")} )`
        }
        // if we don't have a blockNumber, bring in all the matched >= 0 records in the last 12 hours [matched=-1 implies we suppressed it from xcmmessage_dedup process]
        let w = (blockNumber) ? `( blockNumber = '${parseInt(blockNumber, 10)}' )` : "blockTS > UNIX_TIMESTAMP(date_sub(Now(), interval 10 day))";
        let mysqlQuery = `SELECT msgHash, msgStr as msg, version, sentAt, chainID, chainIDDest, msgType, blockNumber, incoming, blockTS, extrinsicHash, extrinsicID, sectionMethod, sourceTS, destTS, beneficiaries, assetsReceived, amountSentUSD, amountReceivedUSD, matched, UNIX_TIMESTAMP(matchDT) as matchTS, parentMsgHash, parentSentAt, parentBlocknumber, childMsgHash, childSentAt, childBlocknumber, sourceBlocknumber as blockNumberOutgoing, destBlocknumber as blockNumberIncoming, executedEventID, destStatus, errorDesc, relayChain FROM xcmmessages where ${w} and matched >= 0 ${chainListFilter} order by blockTS desc limit ${limit}`;
        console.log(mysqlQuery);
        let results = [];
        let recs = await this.poolREADONLY.query(mysqlQuery);
        let blockNumberIncoming = {};
        let blockNumberOutgoing = {};
        let included = {};
        for (let i = 0; i < recs.length; i++) {
            let r = recs[i];
            try {
                let assetsReceived = JSON.parse(r.assetsReceived)
                let dedupedAssetsReceived = []
                let eventIDMap = {}
                for (const ar of assetsReceived) {
                    if (eventIDMap[ar.eventID] == undefined) {
                        eventIDMap[ar.eventID] = 1
                        dedupedAssetsReceived.push(ar)
                    }
                }
                r.assetsReceived = dedupedAssetsReceived
            } catch (e) {
                r.assetsReceived = []
            }

            let chainID = parseInt(r.chainID, 10);
            let chainIDDest = parseInt(r.chainIDDest, 10);
            let parsedMsg = {};
            let [_chainID, id] = this.convertChainID(chainID)
            let [_chainIDDest, idDest] = this.convertChainID(chainIDDest)
            r.id = id
            r.idDest = idDest;
            r.msg = JSON.parse(r.msg.toString());
            r.chainName = this.getChainName(chainID);
            r.chainDestName = this.getChainName(chainIDDest);
            // TODO : use new abstraction in paraTool
            r.relayChain = (r.chainIDDest != 2 && (r.chainIDDest < 10000)) ? 'polkadot' : 'kusama';
            if (r.matched == 0 && (this.getCurrentTS() - r.blockTS < 60)) {
                // if this record hasn't been matched, mark as pending / in transit if its very new (60s)
                r.pending = 1;
            }
            if (r.matched == 0 && (included[r.msgHash] != undefined) && Math.abs(included[r.msgHash] - r.blockTS) < 30) {
                // if we already included a matched message within 30s of this one, don't bother
            } else if (included[r.msgHash] == undefined) {
                results.push(r);
                included[r.msgHash] = r.blockTS;
            }
        }
        return (results);
    }

    async getXCMMessages(query = {}, limit = 1000, decorate = true, decorateExtra = true) {
        return this.bq_query_xcmmessages("xcm", query, limit, decorate, decorateExtra);
    }

    // TODO: reenable usage
    async bq_query_xcmmessages(tbl = "xcm", filters = {}, limit = 100) {
        const bigqueryClient = new BigQuery();
        let fullTable = this.getBQTable(tbl);

        let flds = "id as xcmID, d as chainID, c as chainIDDest, t as msgType, h as msgHash, b as msgHex, s as msgStr, UNIX_SECONDS(ts) as ts, bn as blockNumber, if ((c!=2 and c<10000), 'polkadot', 'kusama') as relayChain, sn as sentAt"
        let fldsmysql = "xcmID, chainID, chainIDDest, msgType, msgHash, msgHex, msgStr, blockTS as ts, blockNumber, relayChain, sentAt"

        let w = [];
        let wr = [];

        for (const filt of Object.keys(filters)) {
            let v = filters[filt]
            switch (filt.toLowerCase()) {
                case "blocknumberstart":
                case "blockstart":
                case "startblock":
                    w.push(`bn >= ${v}`);
                    wr.push(`blockNumber >= '${v}'`)
                    break;
                case "endblock":
                case "blockend":
                case "blocknumberend":
                    w.push(`bn <= ${v}`);
                    wr.push(`blockNumber <= '${v}'`)
                    break;
                case "msgtype":
                    w.push(`t = '${v}'`);
                    wr.push(`msgType = '${v}'`)
                    break;
                case "relaychain":
                    //TODO: need to write xcm.rc for  this to work
                    //w.push(`rc = '${v}'`);
                    //TODO..
                    if (v.toLowerCase() == 'polkadot') {
                        w.push(`(c!=2 and c<10000)`);
                        wr.push(`relayChain = 'polkadot'`)
                    }
                    if (v.toLowerCase() == 'kusama') {
                        w.push(`(c=2 or (c>=20000 and c<30000))`);
                        wr.push(`relayChain = 'kusama'`)
                    }
                    if (v.toLowerCase() == 'moonbase-relay') {
                        w.push(`(c=60000 or (c>=60000 and c<70000))`);
                        wr.push(`relayChain = 'moonbase-relay'`)
                    }
                    break;
                case "datestart":
                case "startdate":
                    w.push(`_PARTITIONDATE >= '${v}'`);
                    wr.push(`date(from_unixtime(blockTS)) >= '${v}'`)
                    break;
                case "dateend":
                case "enddate":
                    w.push(`_PARTITIONDATE <= '${v}'`);
                    wr.push(`date(from_unixtime(blockTS)) <= '${v}'`)
                    break;
                case "chainid":
                case "chainidentifier":
                    let [chainID, id] = this.convertChainID(v)
                    if (chainID !== false) {
                        w.push(`d = ${chainID}`);
                        wr.push(`chainID = '${chainID}'`)
                    } else {
                        throw new Error(`invalid chainIdentifier: ${v}`);
                    }
                    break;
                case "chainiddest":
                case "chainidentifierdest":
                    let [chainIDDest, id2] = this.convertChainID(v)
                    if (chainIDDest !== false) {
                        w.push(`c = ${chainIDDest}`);
                        wr.push(`chainIDDest = '${chainIDDest}'`)
                    } else {
                        throw new Error(`invalid chainIdentifierDest: ${v}`);
                    }
                    break;

                default:
                    throw new Error(`XCM Messages invalid filter: ${filt}`);
            }
        }
        let sqlQuery = ``;
        if (w.length > 0) {
            sqlQuery = `SELECT ${flds}
           FROM ${fullTable}
           WHERE ` + w.join(" and ") + `
           ORDER By ts desc LIMIT ${limit}`;
        }

        const options = {
            query: sqlQuery,
            // Location must match that of the dataset(s) referenced in the query.
            location: 'US',
        };

        try {
            // Run the query
            const [rows] = await bigqueryClient.query(options);
            var results = []
            /*
            {
              "xcmID": "1334065-1-dmp-2000-0-0",
              "chainID": 0,
              "id": "polkadot",
              "chainName": "Polkadot",
              "chainIDDest": 2000,
              "idDest": "acala",
              "chainDestName": "Acala",
              "msgType": "dmp",
              "msgHash": "a6fd9ca31c18b44d64cdfed29c90eebeb89548f294cf2389ca76e56b79f4f367",
              "msgHex": "0x02100104000100000700e87648170a13000100000700e8764817010300286bee0d010004000101006642ee28fc1b7d1a01ea2bc956bfe5fde1c7121cae33afe51a83cc683785a81f",
              "msgStr": "{\"v2\":[{\"reserveAssetDeposited\":[{\"id\":{\"concrete\":{\"parents\":1,\"interior\":{\"here\":null}}},\"fun\":{\"fungible\":100000000000}}]},{\"clearOrigin\":null},{\"buyExecution\":{\"fees\":{\"id\":{\"concrete\":{\"parents\":1,\"interior\":{\"here\":null}}},\"fun\":{\"fungible\":100000000000}},\"weightLimit\":{\"limited\":4000000000}}},{\"depositAsset\":{\"assets\":{\"wild\":{\"all\":null}},\"maxAssets\":1,\"beneficiary\":{\"parents\":0,\"interior\":{\"x1\":{\"accountId32\":{\"network\":{\"any\":null},\"id\":\"0x6642ee28fc1b7d1a01ea2bc956bfe5fde1c7121cae33afe51a83cc683785a81f\"}}}}}}]}",
              "ts": 1656594360,
              "blockNumber": 1334065,
              "relayChain": "Polkadot",
              "sentAt": 10962759
            }
            */
            let keys = {};
            for (let i = 0; i < rows.length; i++) {
                let r = rows[i];
                let currXcmID = r.xcmID
                let chainID = r.chainID;
                let chainIDDest = r.chainIDDest;
                let msgHash = (r.msgHash.substr(0, 2) != "0x") ? '0x' + r.msgHash : r.msgHash

                if (keys[currXcmID] !== undefined) continue // remove duplicate here
                let parsedMsg = null;
                try {
                    parsedMsg = JSON.parse(r.msgStr)
                } catch (e) {
                    parsedMsg = {}
                }
                let [_chainID, id] = this.convertChainID(chainID)
                let [_chainIDDest, idDest] = this.convertChainID(chainIDDest)
                let x = {
                    xcmID: currXcmID,
                    chainID: chainID,
                    id: id,
                    chainName: this.getChainName(chainID),
                    chainIDDest: chainIDDest,
                    idDest: idDest,
                    chainDestName: this.getChainName(chainIDDest),
                    msgType: r.msgType,
                    msgHash: msgHash,
                    msgHex: `${r.msgHex}`,
                    //msgStr: r.msgStr,
                    msgDecoded: parsedMsg,
                    blockNumber: r.blockNumber,
                    relayChain: r.relayChain,
                    sentAt: r.sentAt,
                    ts: r.ts,
                }
                if (r.ts != undefined && r.ts.value != undefined) {
                    x.ts = r.ts.value;
                }
                if (r.chainID != undefined && r.chainIDDest != undefined) {
                    keys[currXcmID] = true;
                    results.push(x)
                }
            }

            // Add rows from mysql "recent" table
            let numRecents = 0;
            if (fldsmysql.length > 0) {
                let mysqlQuery = `SELECT ${fldsmysql} FROM xcmmessages WHERE ` + wr.join(" and ") + ` LIMIT ${limit}`;
                let recs = await this.poolREADONLY.query(mysqlQuery);
                for (let i = 0; i < recs.length; i++) {
                    let r = recs[i];
                    if (keys[r.xcmID] !== undefined) {

                    } else {
                        keys[r.xcmID] = true
                        let chainID = r.chainID;
                        let chainIDDest = r.chainIDDest;
                        let parsedMsg = {};
                        try {
                            parsedMsg = JSON.parse(r.msgStr)
                        } catch (e) {

                        }
                        let [_chainID, id] = this.convertChainID(chainID)
                        let [_chainIDDest, idDest] = this.convertChainID(chainIDDest)
                        r.id = id
                        r.msgDecoded = parsedMsg;
                        r.idDest = idDest
                        r.chainName = this.getChainName(chainID);
                        r.chainDestName = this.getChainName(chainIDDest);
                        numRecents++;
                        results.push(r);
                    }
                }
            }
            return (results);
        } catch (err) {
            this.logger.error({
                "op": "query.bq_query",
                err,
                filters
            });
            throw new Error("An error has occurred.")
        }

    }

    async getSpecVersionMetadata(chainID_or_chainName, specVersion) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) {
            throw new paraTool.InvalidError(`Invalid chain: ${chainID_or_chainName}`)
        }

        var sql = `select specVersion, metadata, blockNumber, blockHash, UNIX_TIMESTAMP(firstSeenDT) as firstSeenTS from specVersions where chainID = '${chainID}' and specVersion = '${specVersion}' limit 1`
        try {
            let recs = await this.poolREADONLY.query(sql);
            if (recs.length > 0) {
                recs[0].metadata = recs[0].metadata.toString();
                return recs[0];
            }
            return (false);
        } catch (err) {
            this.logger.error({
                "op": "query.getSpecVersionMetadata",
                err,
                filters
            });
        }
    }


    async getSpecVersions(chainID_or_chainName) {
        // Based on metadata crawl, supply metadata for latest specVersion;
        // NOTE: we could dump all older specVersions but all older metadata is overkill.
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) {
            throw new paraTool.InvalidError(`Invalid chain: ${chainID_or_chainName}`)
        }

        try {
            var sql = `select specVersion, blockNumber, blockHash, UNIX_TIMESTAMP(firstSeenDT) as firstSeenTS from specVersions where chainID = ${chainID} order by specVersion DESC`
            let recs = await this.poolREADONLY.query(sql);
            return (recs);
        } catch (err) {
            this.logger.error({
                "op": "query.getSpecVersions",
                chainID,
                err
            });
        }
        return false;
    }

    async getChainLog(chainID_or_chainName, lookback = 90) {
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) {
            throw new paraTool.InvalidError(`Invalid chain: ${chainID_or_chainName}`)
        }
        try {
            var sql = `select logDT, UNIX_TIMESTAMP(logDT) as logTS, numExtrinsics, numEvents, numTransfers, numSignedExtrinsics, valueTransfersUSD, numTransactionsEVM, numAccountsActive, numAddresses, fees, numXCMTransfersIn, numXCMMessagesIn, numXCMTransfersOut, numXCMMessagesOut, valXCMTransferIncomingUSD, valXCMTransferOutgoingUSD from blocklog where chainID = '${chainID}' and logDT >= date_sub(Now(), interval ${lookback} DAY) order by logDT desc`;
            let recs = await this.poolREADONLY.query(sql);
	    for ( let i = 0; i < recs.length ; i++) {
		let [logDT, _] = paraTool.ts_to_logDT_hr(recs[i].logTS);
		recs[i].logDT = logDT;
	    }
            return (recs);
        } catch (err) {
            this.logger.error({
                "op": "query.getChainLog",
                chainID,
                err
            });
        }
        return false;
    }

    async getExtrinsicDocs(chainID_or_chainName, s, m) {
        // Based on metadata crawl, supply metadata for latest specVersion;
        // NOTE: we could dump all older specVersions but all older metadata is overkill.
        let [chainID, id] = this.convertChainID(chainID_or_chainName)
        if (chainID === false) return (false);
        try {
            var sql = `select chainID, section, method, docs from extrinsicdocs where chainID = ${chainID} and section = '${s}' and method = '${m}' limit 1`
            let docs = await this.poolREADONLY.query(sql);
            if (docs.length > 0) {
                return docs[0];
            }
            return (docs);
        } catch (err) {

        }
        return (false);
    }

    /*
    For each crowdloan, write 2 cells into "hashes.related"
    (a) forward direction (fromAddress => memo)
    (b) reverse direction (memo => fromAddress)
    mysql> select ts, paraID, fromAddress, memo from crowdloan where memo in ( select holder from assetholder ) limit 10;
    +------------+--------+--------------------------------------------------------------------+--------------------------------------------------------------------+
    | ts         | paraID | fromAddress                                                        | memo                                                               |
    +------------+--------+--------------------------------------------------------------------+--------------------------------------------------------------------+
    | 1636706034 |   2004 | 0x9433e03eb43fb7f086f150a56b229e38150ab5411934438252520486e9fc047d | 0xcaadf7c0f8f58b8b468d201bfac676c135eb75d4                         |
    | 1637695278 |   2006 | 0x768e9b1c7df028c6f9c8cd702bc938a51a455d7babbd2434f751fe47c1007437 | 0x4ab52bb8245e545fc6b7861df6cf6a2db175f95c99f6b4b27e8f3bb3e9d10c4b |
    */
    async writeCrowdloanRelated(chainID, limit = 1000000) {
        // TODO: 0 vs 2
        let sql = `select chainID, amount, blockNumber, ts, paraID, fromAddress, memo from crowdloan where memo in ( select holder from assetholder${chainID} ) order by ts limit ${limit}`
        let crowdloans = await this.poolREADONLY.query(sql);
        let rows = [];

        for (let c = 0; c < crowdloans.length; c++) {
            let crowdloan = crowdloans[c];
            let replayChain = paraTool.getRelayChainByChainID(parseInt(crowdloan.chainID, 10))
            let paraChainID = paraTool.getChainIDFromParaIDAndRelayChain(crowdloan.paraID, replayChain)
            let paraChainName = this.getChainName(paraChainID);
            let relayChainName = this.getChainName(crowdloan.chainID);
            let relayChainAsset = this.getChainAsset(crowdloan.chainID);
            let [amountUSD, priceUSD, priceUSDCurrent] = await this.computeUSD(crowdloan.amount, relayChainAsset, crowdloan.ts)
            let description = `${paraChainName} Crowdloan Address/Referral (${relayChainName}) ${uiTool.presentCurrency(amountUSD)}`
            let metadata = {
                datasource: "crowdloan",
                relayChainID: crowdloan.chainID,
                relayChainName,
                paraChainName,
                paraChainID,
                amount: crowdloan.amount,
                amountUSD,
                priceUSD,
                paraID: crowdloan.paraID,
                blockNumber: crowdloan.blockNumber,
                ts: crowdloan.ts
            }
            if (paraChainID && paraChainName && relayChainName) {
                // forward direction (fromAddress => memo)
                let related = {}
                related[crowdloan.memo] = {
                    value: JSON.stringify({
                        url: "/account/" + crowdloan.memo,
                        title: crowdloan.memo,
                        description,
                        linktype: "address",
                        metadata: metadata
                    }),
                    timestamp: crowdloan.ts * 1000000
                };
                rows.push({
                    key: crowdloan.fromAddress,
                    data: {
                        related: related
                    }
                });

                // reverse direction (memo => fromAddress)
                let related1 = {}
                related1[crowdloan.fromAddress] = {
                    value: JSON.stringify({
                        url: "/account/" + crowdloan.fromAddress,
                        title: crowdloan.fromAddress,
                        description,
                        linktype: "address",
                        metadata: metadata
                    }),
                    timestamp: crowdloan.ts * 1000000
                }
                rows.push({
                    key: crowdloan.memo,
                    data: {
                        related: related1
                    }
                })
                //console.log(`${crowdloan.fromAddress}`, related)
                if (rows.length > 500) {
                    await this.btHashes.insert(rows);
                    console.log("writeCrowdloanRelated rows=", rows.length);
                    rows = [];
                }
            }
        }
        if (rows.length > 0) {
            await this.btHashes.insert(rows);
            console.log("writeCrowdloanRelated rows=", rows.length);
            rows = [];
        }

    }

    async verifyClaimAddress(address, message, signature) {
        try {
            // check that signed message is from address...
            let verified = paraTool.isValidSignature(message, signature, address);
            if (!verified) {
                return (false);
            }
            let sql = `insert into account ( address, verified, verifyDT ) values ( '${address}', 1, Now() ) on duplicate key update verified = values(verified), verifyDT = values(verifyDT)`
            this.batchedSQL.push(sql);
            await this.update_batchedSQL();
            return (true);
        } catch (err) {
            this.logger.error({
                "op": "query.verifyClaimAddress",
                address,
                message,
                signature,
                err
            });
            return false
        }
    }


    async getChainsReindex() {
        try {
            let sql = `select id, chain.chainID, sum(readyforindexing) as cnt, sum(iF(indexed=0 and readyforindexing > 0, 1, 0)) as TODO, sum(if(indexed=0 and readyforindexing > 0, elapsedSeconds, 0))/(3600*reindexerCount) as hrs, reindexer, reindexerCount from chain join indexlog on indexlog.chainID = chain.chainID where readyforindexing = 1 group by chain.chainID having TODO > 2 order by TODO desc`
            let chains = await this.poolREADONLY.query(sql);
            return chains;
        } catch (err) {
            this.logger.error({
                "op": "query.getChainsReindex",
                err
            });
            return false;
        }
    }

    chainFilters(chainList = [], targetChainID) {
        if (targetChainID == undefined) return false
        if (isNaN(targetChainID)) return false
        let chainID = paraTool.dechexToInt(targetChainID, 10)
        if (chainList.length == 0) {
            return true
        } else if (chainList.includes(chainID)) {
            return true
        }
        return false
    }

    getDecorateOption(decorateExtra) {
        if (Array.isArray(decorateExtra)) {
            let decorateData = decorateExtra.includes("data")
            let decorateAddr = decorateExtra.includes("address")
            let decorateUSD = decorateExtra.includes("usd")
            let decorateRelated = decorateExtra.includes("related")
            // TODO: deep events/logs let decorateDeep = decorateExtra.includes("deep")
            return [decorateData, decorateAddr, decorateUSD, decorateRelated]
        } else if (decorateExtra == true) {
            // remove this once ready
            return [true, true, true, true]
        } else if (decorateExtra == false) {
            return [true, true, true, false]
        } else {
            //return nothing if user purposefully pass in non-matched filter
            return [false, false, false, false]
        }
    }

    getRewardLevelHOLIC(action) {
        let rewardAmount = 0;
        switch (action) {
            case "addresssuggestion":
                rewardAmount = 25;
                break;
            case "issuereport":
                rewardAmount = 100;
                break;
            case "securityreport":
                rewardAmount = 2500;
                break;
        }
        return rewardAmount * 1000000000000;
    }

    async getRecentAddressSuggestions(status = "Submitted", lookbackDays = 7) {
        let sql = `select address, submitter, nickname, addressType, submitDT, status, judgementDT from addresssuggestion where status = '${status}' and submitDT > date_sub(Now(), INTERVAL ${lookbackDays} DAY) order by submitDT Desc`
        let suggestions = await this.pool.query(sql)
        return suggestions;
    }

    async updateAddressSuggestionStatus(address, submitter, status, judge = "") {
        if (address.length != 66) return (false)
        if (submitter.length != 66) return (false);
        if (!(status == "Accepted" || status == "Rejected")) return (false);
        let sql = `update addresssuggestion set status = '${status}', judgementDT = Now(), judge = ${mysql.escape(judge)} where address = '${address}' and submitter = '${submitter}'`
        this.batchedSQL.push(sql);
        if (status == "Accepted") {
            let rewardAmount = this.getRewardLevelHOLIC("addresssuggestion");
            let sql2 = `insert into rewardsholic (address, amount, grantDT, rewardStatus) values ( '${address}',  '${rewardAmount}', Now(), 'Granted' )`
            this.batchedSQL.push(sql2);
        }
        await this.update_batchedSQL();
    }

    async submitAddressSuggestion(address, nickname, submitter, addressType) {
        if (address.length != 66) return ({
            err: "Invalid address"
        });
        if (submitter.length != 66) return ({
            err: "Invalid submitter"
        });
        if (nickname.length < 4 || nickname.length > 128) return ({
            err: "Invalid suggestion (nicknames should be between 4 and 128 characters"
        });
        // TODO: check for spamming by submitter
        try {
            let vals = ["nickname", "addressType", "submitDT"];
            let data = `('${address}', '${submitter}', ${mysql.escape(nickname)}, '${addressType}', Now() )`;
            await this.upsertSQL({
                "table": "addresssuggestion",
                "keys": ["address", "submitter"],
                "vals": vals,
                "data": [data],
                "replace": vals
            });
            return {
                status: "Your suggestion has been received."
            }
        } catch (err) {
            return {
                err: "An error has occurred."
            }
        }
    }

    get_filter(paraID, paraIDDest, mpType, advanced = false) {
        function pvFilter(inp) {
            if (inp.pv != undefined) {
                if (inp.pv == "[]") {
                    return (false);
                }
            }
            return (true);
        }

        function requirePKExtraMatch(inp) {
            // MK WIP
            // return (true);
            if (inp.pkExtra != undefined) {
                let pkExtra = JSON.parse(inp.pkExtra);
                if (pkExtra.length > 0) {
                    let pkparaID = parseInt(pkExtra[0].replace(",", ""), 10);
                    // never seen more than 1 ... could accept any
                    return (pkparaID == paraID || pkparaID == paraIDDest);
                }
            }
            return (true);
        }

        // hrmp [2000->2004] 0xffc0bc017d8b0f0f383e579721fcc4cb434a3589e2f339a98d34a9dab00487aa
        // dmp  [0->2000] 0x28c5915be3fd9c204881cc5ad9e050d8d0b4597ebc1b45b523a12074056c9142
        // ump  [2000->0] 0xfa44ca4eb7069ffac0d1a7a7a0ab48771206e78346c80d7ef8f31c7726c0fae8
        // general filter for all xcm
        // parachain (outgoing)
        let filter = [];
        filter.push(["trace", 'ParachainSystem', 'RelevantMessagingState', null, "mqc"]) // not sure how this is used yet [but has hrmpMqc] in ingressChannels/egressChannels - check msgCount
        if (advanced) {
            filter.push(["trace", 'ParachainSystem', 'validationData']) // RelayParent's BN + StorageRoot that is used to build this para block
        }

        filter.push(["trace", 'XcmpQueue', 'InBoundXcmpStatus', pvFilter]) //
        filter.push(["trace", 'XcmpQueue', 'OutBoundXcmpMessages', pvFilter, 'TBD']) // check extra key?
        filter.push(["trace", 'XcmpQueue', 'OutBoundXcmpStatus', pvFilter]) // This is currently empty?
        if (advanced) {
            filter.push(["trace", 'PolkadotXcm', 'VersionDiscoveryQueue', pvFilter, "version"]) // Not sure how it's used
        }

        //relayChain (outgoing)
        if (advanced) {
            filter.push(["trace", 'XcmPallet', 'VersionDiscoveryQueue', pvFilter, "version"]) // Not sure how it's used
            filter.push(["trace", 'ParaInclusion', 'PendingAvailability', requirePKExtraMatch, "anchor"]) // not useful / Not sure how it's used
        }
        //incoming?

        // outgoingXCM extrinsics: a list of known section:method that triggers xcm
        // TODO: how to get into nested case
        filter.push(["events", "xcmPallet", "AssetsTrapped", null, 'asset']); // error case?
        filter.push(["events", "xcmPallet", "Sent", null, 'asset']); //?

        //xTokens
        filter.push(["extrinsics", "xTokens", ""]); //catch unknown case
        filter.push(["extrinsics", "xTokens", "transfer"]);
        filter.push(["extrinsics", "xTokens", "transferMulticurrencies"]);
        filter.push(["extrinsics", "xTokens", "transferMultiasset"]);
        filter.push(["events", "xTokens", "TransferredMultiAssets"]); //msg
        filter.push(["events", "xcmpQueue", "XcmpMessageSent", null, 'msghash']); //msgHash

        //xcmPallet
        filter.push(["extrinsics", "xcmPallet", ""]); //catch unknown case
        filter.push(["extrinsics", "xcmPallet", "teleportAssets"]);
        filter.push(["extrinsics", "xcmPallet", "limitedTeleportAssets"]);
        filter.push(["extrinsics", "xcmPallet", "reserveTransferAssets"]);
        filter.push(["extrinsics", "xcmPallet", "limitedReserveTransferAssets"]);
        filter.push(["extrinsics", "xcmPallet", "send"]);

        filter.push(["events", "xcmPallet", "Attempted", null, 'something']);
        filter.push(["events", "xcmPallet", "AssetsTrapped", null, 'something']);

        //polkadotXcm //observed on statemine/statemint
        filter.push(["extrinsics", "polkadotXcm", ""]); //catch unknown case
        filter.push(["extrinsics", "polkadotXcm", "teleportAssets"]);
        filter.push(["extrinsics", "polkadotXcm", "limitedTeleportAssets"]);
        filter.push(["extrinsics", "polkadotXcm", "reserveTransferAssets"]);
        filter.push(["extrinsics", "polkadotXcm", "limitedReserveTransferAssets"]);
        filter.push(["extrinsics", "polkadotXcm", "send"]);
        filter.push(["extrinsics", "xcmTransactor", ""]); //catch all xcmTransactor events
        filter.push(["extrinsics", "xcmTransactor", "transactThroughDerivative"]); //catch all xcmTransactor events

        filter.push(["events", "polkadotXcm", "Attempted"]); //not helpful..
        filter.push(["events", "polkadotXcm", "Notified"]);

        filter.push(["events", "xcmpQueue", ""]); //catch all xcmpQueue events
        filter.push(["events", "ump", ""]); //catch all ump events
        filter.push(["events", "dmpQueue", ""]); //catch all dmpQueue events
        filter.push(["events", "xcmTransactor", "transactedDerivative", ""]); //catch all xcmTransactor events

        if (advanced) {
            filter.push(["extrinsics", "parachainSystem", "setValidationData"]);
            filter.push(["extrinsics", "paraInherent", "enter"]);
        }

        // build list of section:method / section:storage to find in events/autotrace at incoming side
        if (mpType == 'ump') { // ump [para -> relay]
            // SENDING xcmmessage on para
            filter.push(["trace", 'ParachainSystem', 'UpwardMessages', pvFilter, 'xcmmessage']) // (potentially empty + have duplicates) ... BIZARRE "[0x..]" string
            // RECEIVING msgHash on relay
            filter.push(["events", "ump", "ExecutedUpward", null, 'msghash']);
            filter.push(["events", "ump", "UpwardMessagesReceived", null, 'count']); // num of msg, not useful but keeping for now
            if (advanced) {
                filter.push(["trace", 'Ump', 'NextDispatchRoundStartWith']) // Not sure how it's used
                filter.push(["trace", 'Ump', 'NeedsDispatch', pvFilter]) // Not sure how it's used
            }
        } else if (mpType == 'dmp') { // dmp [relay -> para]
            // SENDING RAW MESSAGE on relay
            filter.push(["trace", 'Dmp', 'DownwardMessageQueues', requirePKExtraMatch, 'xcmmessage']) // ****** RAW MESSAGE in "pv" field "msg" along with "sentAt"
            filter.push(["trace", 'Dmp', 'DownwardMessageQueueHeads', null, "heads"]) // not useful
            // RECEIVING msgHash on para
            filter.push(["events", "dmpQueue", "ExecutedDownward", null, 'msghash']); // RECEIVING msgHash on para
            filter.push(["events", "ParachainSystem", "DownwardMessagesReceived", null, "count"]); //num of msg, not useful but keeping for now
            filter.push(["events", "ParachainSystem", "DownwardMessagesProcessed", null, "processed"]); //head?
        } else if (mpType == 'hrmp') { // hrmp [para -> para]
            // SENDING RAW MESSAGE on para
            filter.push(["trace", 'ParachainSystem', 'HrmpOutboundMessages', pvFilter, 'xcmmessage']) // hrmp outbound (potentially empty + have duplicates)
            // RECEIVING msgHash on para
            filter.push(["events", "xcmpQueue", "Success", null, 'msghash']); //msgHash
            filter.push(["events", "xcmpQueue", "Fail", null, 'msghash']); //msgHash
            filter.push(["trace", 'ParachainSystem', 'LastHrmpMqcHeads', null, "mqc"]) // hrmpMqc per each open channel (paraIDs)
            filter.push(["trace", 'ParachainSystem', 'HrmpWatermark', null, 'watermark']) // hrmp get updated for this block
        }
        //if ( mpType == 'dmp' || mpType == 'hrmp' ) {
        filter.push(["events", "balances", "Deposit", null, 'beneficiary']);
        filter.push(["events", "currencies", "Deposited", null, 'beneficiary']);
        filter.push(["events", "tokens", "Deposited", null, 'beneficiary']);
        filter.push(["events", "assets", "Issued", null, 'beneficiary']);
        //}
        return (filter);
    }

    filter_block_row_objects_and_msgHashes(rRow, filter, chainID, extrinsicHash = null, eventIDs = [], blockNumber, blockTS) {
        // add id, idDest, chainName, chainNameDest
        let [_, id] = this.convertChainID(chainID)
        let chainName = this.getChainName(chainID);
        let out = [];
        let extra = {}
        let msgHashes = [];
        let matcher = {
            "trace": {},
            "events": {},
            "extrinsics": {}
        };
        let features = {}

        let idx = 0;
        for (let i = 0; i < filter.length; i++) {
            let f = filter[i]
            let scope = f[0];
            let section = `${f[1].toLowerCase()}`
            let method = `${f[2].toLowerCase()}`
            let filterfunc = (f.length > 3 && f[3]) ? f[3] : true;
            if (section == '' && method == '') {
                //error filter
            } else if (section == '' && method != '') {
                //section not set, method is set, match on method only
                matcher[scope][method] = filterfunc;
            } else if (section != '' && method == '') {
                //section is set, method not set, match on section only
                let s = `${f[1].toLowerCase()}`
                matcher[scope][section] = filterfunc;
            } else {
                //if section, method is set, match on section:method
                matcher[scope][`${section}:${method}`] = filterfunc;
                let feature = (f.length > 4) ? f[4] : false; // xcmmessage (1) or msghash (1) or something (0)
                if (feature) {
                    features[`${section}:${method}`] = feature;
                }
            }
        }
        //console.log(`Filter`, matcher); //JSON.stringify(matcher, null, 2)
        if (rRow.feed) {
            rRow.feed.extrinsics.forEach((e) => {
                // extrinsics filtering on matcher["extrinsics"]
                let s = `${e.section.toLowerCase()}`
                let m = `${e.method.toLowerCase()}`
                let sm = `${s}:${m}`
                if (matcher["extrinsics"][sm] || matcher["extrinsics"][s] || matcher["extrinsics"][m]) {
                    if (e.extrinsicHash == extrinsicHash) {
                        out.push({
                            "chainID": chainID,
                            "id": id,
                            "chainName": chainName,
                            "blockNumber": blockNumber,
                            "type": "extrinsic",
                            "obj": e,
                            "ts": blockTS + .001
                        });
                        idx++
                    }
                }
                // add events filtering on matcher["events"]
                e.events.forEach((ev) => {
                    let s2 = `${ev.section.toLowerCase()}`
                    let m2 = `${ev.method.toLowerCase()}`
                    let sm2 = `${s2}:${m2}`
                    if (matcher["events"][sm2] || matcher["events"][s2] || matcher["events"][m2]) {
                        // RULE: if we find an event that has a beneficiary feature, the eventID must be inside eventIDs
                        let pass = (features[sm2] == "beneficiary") ? eventIDs.includes(ev.eventID) : true;
                        if (features[sm2] != undefined) {
                            if (features[sm2] == "processed") {
                                extra[ev.method] = ev.data;
                            } else if (features[sm2] == "count") {
                                extra[ev.method] = ev.data;
                            }
                        }
                        if (pass) {
                            ev.extrinsicHash = e.extrinsicHash;
                            ev.extrinsicID = e.extrinsicID
                            out.push({
                                "chainID": chainID,
                                "id": id,
                                "chainName": chainName,
                                "blockNumber": blockNumber,
                                "type": "event",
                                "obj": ev,
                                "ts": blockTS + idx * .001
                            });
                            idx++;
                        }
                    }
                });
            });
        }
        if (rRow.autotrace) {
            // trace filtering on matcher["trace"]
            let traces = rRow.autotrace.filter((f) => {
                f.traceID = `${chainID}-${f.traceID}`
                if (paraTool.isJSONString(f.pv)) {
                    try {
                        let pvParsed = JSON.parse(f.pv)
                        f.pv = pvParsed;
                    } catch {
                        // leave it alone
                    }
                }
                if (f.xcmMessages != undefined && Array.isArray(f.xcmMessages)) {
                    try {
                        let xcmMessagesParsed = f.xcmMessages.map((m) => {
                            return JSON.parse(m)
                        });
                        f.xcmMessages = xcmMessagesParsed;
                    } catch {
                        // leave it alone
                    }
                }
                let s = `${f.p.toLowerCase()}`
                let m = `${f.s.toLowerCase()}`
                let sm = `${s}:${m}`
                let fv = `${f.v}`
                if (matcher["trace"][sm] || matcher["trace"][s] || matcher["trace"][m]) {
                    // pass the data "f" through the filtering function
                    let func = (matcher["trace"][sm] != undefined && matcher["trace"][sm] != true) ? matcher["trace"][sm] : null;
                    let pass = (func) ? func(f) : true;
                    if (fv == '0x' || fv == '0x0400') pass = false
                    if (pass) {
                        if (features[sm] != undefined) {
                            if (features[sm] == "watermark" && f.pv != undefined) {
                                extra[f.s] = f.pv;
                            }
                        }
                        //delete k, v if s,k, PV is known
                        if (f.pv != undefined) delete f.v
                        if (f.p != undefined && f.s != undefined) delete f.k
                        out.push({
                            "chainID": chainID,
                            "id": id,
                            "chainName": chainName,
                            "blockNumber": blockNumber,
                            "type": "trace",
                            "obj": f,
                            "ts": blockTS + idx * .001
                        });
                        idx++;
                    }
                }
            })
        }
        return [out, extra];
    }

    async getEvent(eventID) {
        let ida = eventID.split("-");
        if (ida.length != 4) {
            throw new paraTool.NotFoundError(`Invalid eventID`)
        }
        let chainID = parseInt(ida[0], 10);
        let blockNumber = parseInt(ida[1], 10);
        let extrinsic = parseInt(ida[2], 10);
        let event = parseInt(ida[3], 10)
        let [_, id] = this.convertChainID(chainID);
        let chain = await this.getChain(chainID);

        try {
            let families = ["feed", "finalized", "feedevm"];
            let row = await this.fetch_block(chainID, blockNumber, families, true);
            let block = row.feed;
            let eventIndex = 0;
            for (const extrinsic of block.extrinsics) {
                for (const e of extrinsic.events) {
                    if (eventIndex == event) {
                        return (e)
                    }
                    eventIndex++
                }
            }
            if (event < ext.events.length) {
                return (events[event]);
            } else {
                throw new paraTool.NotFoundError(`Invalid eventID: Event ${event} not in Extrinsic ${extrinsic} of Block number ${blockNumber} (# Events: ${events.length})`)
            }
            return event;
        } catch (err) {
            if (err.code == 404) {
                throw new paraTool.NotFoundError(`Block not found: ${blockNumber}`)
            }
            this.logger.error({
                "op": "query.getEvent",
                chainID,
                blockNumber,
                err
            });
        }
        return (null);
    }


    async getXCMMessage(msgHash, blockNumber = null, decorate = true, decorateExtra = true) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let w = (blockNumber) ? ` and blockNumber = ${blockNumber}` : "";
        let sql = `select msgHash, chainID, chainIDDest, sentAt, msgType, msgHex, msgStr as msg, blockTS, blockNumber, relayChain, version, path, extrinsicHash, extrinsicID, parentMsgHash, parentSentAt, parentBlocknumber, childMsgHash, childSentAt, childBlocknumber, assetChains, blockTS, incoming, sourceTS, destTS, sourceSentAt, destSentAt, sourceBlocknumber, destBlocknumber, executedEventID, destStatus, errorDesc from xcmmessages
        where msgHash = '${msgHash}' ${w} order by blockTS desc limit 1`
        let xcmrecs = await this.poolREADONLY.query(sql);
        if (xcmrecs.length == 0) {
            throw new paraTool.NotFoundError(`XCM Message not found: ${msgHash}/${blockNumbersentAt}`)
        }
        let x = xcmrecs[0];
        x.paraID = paraTool.getParaIDfromChainID(x.chainID)
        x.paraIDDest = paraTool.getParaIDfromChainID(x.chainIDDest)
        x.msgHex = `${x.msgHex}`

        let blockTS = (x.blockTS != undefined) ? x.blockTS : 0
        let dAssetChains = []
        if (x.assetChains) {
            dAssetChains = await this.decorateXCMAssetReferences(x.assetChains, blockTS, decorate, decorateExtra)
            x.assetChains = dAssetChains
        }

        let xcmMsg = (x.msg != undefined) ? JSON.parse(x.msg) : null
        x.msg = xcmMsg
        if (xcmMsg != undefined) {
            let xcmMsg0 = JSON.parse(JSON.stringify(xcmMsg)) // deep copy here
            let dMsg = await this.decorateXCMMsg(xcmMsg0, blockTS, dAssetChains, decorate, decorateExtra)
            x.decodeMsg = dMsg
            if (dMsg.destAddress != undefined) {
                x.destAddress = dMsg.destAddress
                x.destSS58Address = this.getSS58ByChainID(x.destAddress, x.chainIDDest)
            }
        }
        if (decorate) this.decorateAddress(x, "destAddress", decorateAddr, decorateRelated);
        x.path = (x.path != undefined) ? JSON.parse(x.path) : []
        // add id, idDest, chainName, chainNameDest
        let [_, id] = this.convertChainID(x.chainID)
        x.chainName = this.getChainName(x.chainID);
        let [__, idDest] = this.convertChainID(x.chainIDDest)

        x.id = id
        x.idDest = idDest
        x.chainDestName = this.getChainName(x.chainIDDest);
        return x;
    }

    /*
    decorateXCM -- in query.js "getXCMMessage" compute
    (a) asset referenced;
    (b) estimated valueUSD to any XCM instruction
    (c) estimated value xcm contained within
    (d) any encoded call of transact
    (e) any nickname of beneficiary (accountID32/20);
    */
    async decorateXCMAssetReferences(assetChainsStr, blockTS = 0, decorate = true, decorateExtra = true) {
        let assetChains = []
        if (assetChainsStr != undefined) {
            try {
                assetChains = JSON.parse(assetChainsStr)
            } catch (err) {
                console.log(`AssetChains ERR`, err.toString())
                assetChains = []
            }
        }
        let dAssetChains = []
        for (const assetChain of assetChains) {
            let dAssetChain = await this.decorateXCMAssetReference(assetChain, blockTS, decorate, decorateExtra)
            dAssetChains.push(dAssetChain)
        }
        return dAssetChains
    }

    decorateFungible(fun, xcmAssetInfo) {
        if (fun != undefined && fun.fungible != undefined) {
            let assetFun = fun
            let fungible = assetFun.fungible
            let decimals = xcmAssetInfo.decimals
            let fungibleAmount = fungible / 10 ** decimals
            let dassetFun = {
                xcmInteriorKey: xcmAssetInfo.xcmInteriorKey,
                symbol: xcmAssetInfo.symbol,
                decimals: decimals,
                fungible: fungible,
                fungibleAmount: fungibleAmount,
                fungibleUSD: fungibleAmount * xcmAssetInfo.priceUSD,
                fungibleUSDCurrent: fungibleAmount * xcmAssetInfo.priceUSDCurrent,
            }
            //console.log(`decorateFungible ->`, fun)
            return dassetFun
        } else {
            // can't decorate
            return fun
        }
    }

    async decorateInternalXCMInstruction(dXcmMsg, internalXCM, instructionK, instructionV, blockTS = 0, dAssetChains = [], decorate = true, decorateExtra = true) {
        this.chainParserInit(paraTool.chainIDPolkadot, this.debugLevel);
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let dInstructionV = {}
        switch (instructionK) {
            case "withdrawAsset":
            case "reserveAssetDeposited":
                for (let i = 0; i < instructionV.length; i++) {
                    if (dAssetChains.length >= i + 1 && instructionV[i] != undefined && instructionV[i].fun != undefined) {
                        let xcmAssetInfo = dAssetChains[i] // "inferenced"
                        instructionV[i].fun = this.decorateFungible(instructionV[i].fun, xcmAssetInfo)
                        console.log(`++ instructionV[${i}]`, instructionV[i])
                    } else {
                        continue // cannot decorate without going through the messy lookup again..
                    }
                }
                dInstructionV[instructionK] = instructionV
                internalXCM = dInstructionV
                break;
            case "claimAsset":
                if (instructionV.assets != undefined) {
                    let instructionVAssets = instructionV.assets
                    for (let i = 0; i < instructionVAssets.length; i++) {
                        if (dAssetChains.length >= i + 1 && instructionVAssets[i] != undefined && instructionVAssets[i].fun != undefined) {
                            let xcmAssetInfo = dAssetChains[i] // "inferenced"
                            instructionVAssets[i].fun = this.decorateFungible(instructionVAssets[i].fun, xcmAssetInfo)
                            console.log(`++ instructionVAssets[${i}]`, instructionVAssets[i])
                        } else {
                            continue // cannot decorate without going through the messy lookup again..
                        }
                    }
                    instructionV.assets = instructionVAssets
                }
                dInstructionV[instructionK] = instructionV
                internalXCM = dInstructionV
                break;
            case "clearOrigin":
                dInstructionV[instructionK] = instructionV
                internalXCM = dInstructionV
                break;
            case "buyExecution":
                if (instructionV.fees != undefined && instructionV.fees.fun != undefined) {
                    if (dAssetChains.length != 0) {
                        let xcmAssetInfo = dAssetChains[0] // "inferenced"
                        instructionV.fees.fun = this.decorateFungible(instructionV.fees.fun, xcmAssetInfo)
                    }
                }
                dInstructionV[instructionK] = instructionV
                internalXCM = dInstructionV
                break;
            case "depositAsset":
                //TODO: need to decorate addr
                if (instructionV.beneficiary != undefined) {
                    let destAddress = this.chainParser.processBeneficiary(this, instructionV.beneficiary, 'polkadot', true)
                    if (destAddress) {
                        dXcmMsg.destAddress = destAddress
                    }
                }
                dInstructionV[instructionK] = instructionV
                internalXCM = dInstructionV
                break;
            default:
                dInstructionV[instructionK] = instructionV
                internalXCM = dInstructionV
                break;
        }
    }

    async decorateXCMInstructionV1(dXcmMsg, instructionK, instructionV, blockTS = 0, dAssetChains = [], decorate = true, decorateExtra = true) {
        this.chainParserInit(paraTool.chainIDPolkadot, this.debugLevel);
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let version = dXcmMsg.version
        let dInstructionV = {}
        console.log('im here', instructionK, instructionV)
        switch (instructionK) {
            case "withdrawAsset":
            case "reserveAssetDeposited":
                console.log(`instructionV`, instructionV)
                if (instructionV.assets != undefined) {
                    console.log(`instructionV.assets`, instructionV.assets)
                    for (let i = 0; i < instructionV.assets.length; i++) {
                        if (dAssetChains.length >= i + 1 && instructionV.assets[i] != undefined && instructionV.assets[i].fun != undefined) {
                            let xcmAssetInfo = dAssetChains[i] // "inferenced"
                            instructionV.assets[i].fun = this.decorateFungible(instructionV.assets[i].fun, xcmAssetInfo)
                            console.log(`++ instructionV.assets[${i}]`, instructionV.assets[i])
                        } else {
                            continue // cannot decorate without going through the messy lookup again..
                        }
                    }
                }
                if (instructionV.effects != undefined) {
                    console.log(`instructionV.effects`, instructionV.effects)
                    for (let i = 0; i < instructionV.effects.length; i++) {
                        let instructionXCMK = Object.keys(instructionV.effects[i])[0]
                        let instructionXCMV = instructionV.effects[i][instructionXCMK]
                        console.log(`instructionXCMK=${instructionXCMK}, instructionXCMV`, instructionXCMV)
                        await this.decorateInternalXCMInstruction(dXcmMsg, instructionV.effects[i], instructionXCMK, instructionXCMV, blockTS, dAssetChains, decorate, decorateExtra)
                    }
                }
                dInstructionV[instructionK] = instructionV
                //console.log(`dInstructionV`, JSON.stringify(dInstructionV, null, 4))
                dXcmMsg[version] = dInstructionV
                //console.log(`dXcmMsg++`, JSON.stringify(dXcmMsg, null, 4))
                break;
            case "clearOrigin":
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version] = dInstructionV
                break;
            case "buyExecution":
                if (instructionV.fees != undefined && instructionV.fees.fun != undefined) {
                    if (dAssetChains.length != 0) {
                        let xcmAssetInfo = dAssetChains[0] // "inferenced"
                        instructionV.fees.fun = this.decorateFungible(instructionV.fees.fun, xcmAssetInfo)
                    }
                }
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version] = dInstructionV
                break;
            case "depositAsset":
                //TODO: need to decorate addr
                if (instructionV.beneficiary != undefined) {
                    let destAddress = this.chainParser.processBeneficiary(this, instructionV.beneficiary, 'polkadot', true)
                    if (destAddress) {
                        dXcmMsg.destAddress = destAddress
                    }
                }
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version] = dInstructionV
                break;
            case "depositReserveAsset":
                if (Array.isArray(instructionV.xcm)) {
                    for (let i = 0; i < instructionV.xcm.length; i++) {
                        let instructionXCMK = Object.keys(instructionV.xcm[i])[0]
                        let instructionXCMV = instructionV.xcm[i][instructionXCMK]
                        console.log(`instructionXCMK=${instructionXCMK}, instructionXCMV`, instructionXCMV)
                        await this.decorateInternalXCMInstruction(dXcmMsg, instructionV.xcm[i], instructionXCMK, instructionXCMV, blockTS, dAssetChains, decorate, decorateExtra)
                    }
                }
                console.log(`depositReserveAsset final`, JSON.stringify(instructionV, null, 4))
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version] = dInstructionV
                break;
            default:
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version] = dInstructionV
                break;
        }
        console.log('im here 2')
    }

    async decorateXCMInstruction(dXcmMsg, instructionK, instructionV, blockTS = 0, dAssetChains = [], decorate = true, decorateExtra = true) {
        this.chainParserInit(paraTool.chainIDPolkadot, this.debugLevel);
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let version = dXcmMsg.version
        let dInstructionV = {}
        switch (instructionK) {
            case "withdrawAsset":
            case "reserveAssetDeposited":
                for (let i = 0; i < instructionV.length; i++) {
                    if (dAssetChains.length >= i + 1 && instructionV[i] != undefined && instructionV[i].fun != undefined) {
                        let xcmAssetInfo = dAssetChains[i] // "inferenced"
                        instructionV[i].fun = this.decorateFungible(instructionV[i].fun, xcmAssetInfo)
                        console.log(`++ instructionV[${i}]`, instructionV[i])
                    } else {
                        continue // cannot decorate without going through the messy lookup again..
                    }
                }
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version].push(dInstructionV)
                break;
            case "clearOrigin":
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version].push(dInstructionV)
                break;
            case "buyExecution":
                if (instructionV.fees != undefined && instructionV.fees.fun != undefined) {
                    if (dAssetChains.length != 0) {
                        let xcmAssetInfo = dAssetChains[0] // "inferenced"
                        instructionV.fees.fun = this.decorateFungible(instructionV.fees.fun, xcmAssetInfo)
                    }
                }
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version].push(dInstructionV)
                break;
            case "depositAsset":
                //TODO: need to decorate addr
                if (instructionV.beneficiary != undefined) {
                    let destAddress = this.chainParser.processBeneficiary(this, instructionV.beneficiary, 'polkadot', true)
                    if (destAddress) {
                        dXcmMsg.destAddress = destAddress
                    }
                }
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version].push(dInstructionV)
                break;
            case "depositReserveAsset":
                if (Array.isArray(instructionV.xcm)) {
                    for (let i = 0; i < instructionV.xcm.length; i++) {
                        let instructionXCMK = Object.keys(instructionV.xcm[i])[0]
                        let instructionXCMV = instructionV.xcm[i][instructionXCMK]
                        console.log(`instructionXCMK=${instructionXCMK}, instructionXCMV`, instructionXCMV)
                        await this.decorateInternalXCMInstruction(dXcmMsg, instructionV.xcm[i], instructionXCMK, instructionXCMV, blockTS, dAssetChains, decorate, decorateExtra)
                    }
                }
                console.log(`depositReserveAsset final`, JSON.stringify(instructionV, null, 4))
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version].push(dInstructionV)
                break;
            default:
                dInstructionV[instructionK] = instructionV
                dXcmMsg[version].push(dInstructionV)
                break;
        }
    }


    async decorateXCMMsg(xcmMsg, blockTS = 0, dAssetChains = [], decorate = true, decorateExtra = true) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let dXcmMsg = {}
        let version = Object.keys(xcmMsg)[0]
        console.log(`decorateXCMMsg version=${version}`, xcmMsg)
        let xcmMsgV = xcmMsg[version]

        dXcmMsg.version = version


        let xcmPath = []

        //"withdrawAsset", "clearOrigin","buyExecution", "depositAsset"
        if (version == 'v1') {
            let instructionK = Object.keys(xcmMsgV)[0]
            let instructionV = xcmMsgV[instructionK]
            //console.log(`instructionK=${instructionK}, instructionV`, instructionV)
            dXcmMsg[version] = {}
            await this.decorateXCMInstructionV1(dXcmMsg, instructionK, instructionV, blockTS, dAssetChains, decorate, decorateExtra)
        } else if (version == 'v2') {
            dXcmMsg[version] = []
            for (let i = 0; i < xcmMsgV.length; i++) {
                let instructionK = Object.keys(xcmMsgV[i])[0]
                xcmPath.push(instructionK)
            }
            //console.log(`decorateXCMMsg Path`, xcmPath)
            for (let i = 0; i < xcmPath.length; i++) {
                let instructionK = xcmPath[i]
                let instructionV = xcmMsgV[i][instructionK]
                //console.log(`instructionK=${instructionK}, instructionV`, instructionV)
                await this.decorateXCMInstruction(dXcmMsg, instructionK, instructionV, blockTS, dAssetChains, decorate, decorateExtra)
            }
        } else if (version == 'v0') {
            //skip for now
        }
        return dXcmMsg
    }

    async decorateXCMAssetReference(assetChain, blockTS = 0, decorate = true, decorateExtra = true) {
        //{"Token":"KSM"}~2
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        let xcmInteriorKey = null;
        let decimals;
        let symbol;
        let rawassetChain = assetChain
        let [targetAsset, targetChainID] = paraTool.parseAssetChain(rawassetChain)
        let xcmAssetInfo = this.getXcmAssetInfoByNativeAssetChain(rawassetChain)
        if (xcmAssetInfo != undefined) {
            xcmInteriorKey = xcmAssetInfo.xcmInteriorKey
        }
        if (this.assetInfo[rawassetChain] && this.assetInfo[rawassetChain].decimals != undefined) {
            decimals = this.assetInfo[rawassetChain].decimals;
            symbol = this.assetInfo[rawassetChain].symbol
        } else {
            let [nativeAsset, _] = paraTool.parseAssetChain(rawassetChain)
            let [nativeChainID, isFound] = await this.getNativeAssetChainID(nativeAsset)
            if (isFound) {
                targetChainID = nativeChainID
                rawassetChain = paraTool.makeAssetChain(targetAsset, targetChainID);
            }
            if (this.assetInfo[rawassetChain] && this.assetInfo[rawassetChain].decimals != undefined) {
                decimals = this.assetInfo[rawassetChain].decimals;
                symbol = this.assetInfo[rawassetChain].symbol
            } else {
                console.log(`*decimals not found assetChain=${assetChain}`)
            }
        }
        let dXCMAsset = {
            xcmInteriorKey: xcmInteriorKey,
            assetChain: rawassetChain,
            asset: targetAsset,
            chainID: targetChainID,
            decimals: decimals,
            symbol: symbol,
        }
        if (this.assetInfo[rawassetChain]) {
            if (decorateUSD) {
                let [_, priceUSD, priceUSDCurrent] = await this.computeUSD(1, targetAsset, targetChainID, blockTS);
                dXCMAsset.priceUSD = priceUSD
                dXCMAsset.priceUSDCurrent = priceUSDCurrent
            }
            if (this.assetInfo[rawassetChain]) {
                if (decorateUSD) {
                    let [_, priceUSD, priceUSDCurrent] = await this.computeUSD(1, targetAsset, targetChainID, blockTS);
                    dXCMAsset.priceUSD = priceUSD
                    dXCMAsset.priceUSDCurrent = priceUSDCurrent
                }
            }
            return dXCMAsset
        }
    }

    async decorateXCM(rawXcmRec, decorate = true, decorateExtra = true) {
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        rawXcmRec.msgHex = `${rawXcmRec.msgHex}`
        let [parentMsgHash, parentBlocknumber, parentSentAt] = [rawXcmRec.parentMsgHash, rawXcmRec.parentBlocknumber, rawXcmRec.parentSentAt];
        let [childMsgHash, childBlocknumber, childSentAt] = [rawXcmRec.childMsgHash, rawXcmRec.childBlocknumber, rawXcmRec.childSentAt];
        let blockTS = (rawXcmRec.blockTS != undefined) ? rawXcmRec.blockTS : 0
        if (rawXcmRec.version != 'v2') {
            // for debugging
            if (rawXcmRec.relayChain == 'polkadot') {
                rawXcmRec.assetChains = '["{\\"Token\\":\\"DOT\\"}~0"]'
            } else {
                rawXcmRec.assetChains = '["{\\"Token\\":\\"KSM\\"}~2"]'
            }
        }
        //console.log(`decorateXCM, relayChain=${rawXcmRec.relayChain},version=${rawXcmRec.version}, rawXcmRec.assetChains=${rawXcmRec.assetChains}`)
        let dAssetChains = await this.decorateXCMAssetReferences(rawXcmRec.assetChains, blockTS, decorate, decorateExtra)
        //console.log(`dAssetChains`, JSON.stringify(dAssetChains))
        let xcmMsg = (rawXcmRec.msgStr != undefined) ? JSON.parse(rawXcmRec.msgStr) : null
        let dMsg;
        if (xcmMsg != undefined) {
            let xcmMsg0 = JSON.parse(JSON.stringify(xcmMsg)) // deep copy here
            dMsg = await this.decorateXCMMsg(xcmMsg0, blockTS, dAssetChains, decorate, decorateExtra)
        }
        let destAddress = (dMsg.destAddress != undefined) ? dMsg.destAddress : null
        let destSS58Address = this.getSS58ByChainID(destAddress, rawXcmRec.chainIDDest)

        let [_, id] = this.convertChainID(rawXcmRec.chainID);
        let [__, idDest] = this.convertChainID(rawXcmRec.chainIDDest);
        let assetsReceived = rawXcmRec.assetsReceived;
        let dXcm = {
            msgHash: rawXcmRec.msgHash,
            msgHex: rawXcmRec.msgHex,
            msg: xcmMsg,
            msgType: rawXcmRec.msgType,
            version: rawXcmRec.version,
            destAddress: destAddress,
            destSS58Address: destSS58Address,
            received: rawXcmRec.received,
            relayChain: rawXcmRec.relayChain,
            paraID: rawXcmRec.paraID,
            id,
            idDest,
            blockTS: rawXcmRec.blockTS, //TODO: remove ambiguous blockTS
            receivedTS: rawXcmRec.receivedTS,
            sentTS: rawXcmRec.sentTS,
            blockNumber: rawXcmRec.blockNumber, //TODO: remove ambiguous blockNumber, which one depends whether received ... should put paraID blockNumber (sent), paraIDDest blockNumber (received)
            blockNumberReceived: rawXcmRec.blockNumberReceived, // /idDest/blockNumberReceived
            blockNumberSent: rawXcmRec.blockNumberSent, // /id/blockNumberSent
            paraIDDest: rawXcmRec.paraIDDest,
            //decodeMsg: dMsg,
            extrinsicID: rawXcmRec.extrinsicID,
            extrinsicHash: rawXcmRec.extrinsicHash,
            destStatus: rawXcmRec.destStatus,
            executedEventID: rawXcmRec.executedEventID,
            errorDesc: rawXcmRec.errorDesc,
            parentMsgHash,
            parentBlocknumber,
            parentSentAt,
            childMsgHash,
            childBlocknumber,
            childSentAt,
            assetsReceived,
            assetChains: dAssetChains
        }

        if (decorate) this.decorateAddress(dXcm, "destAddress", decorateAddr, decorateRelated);
        return dXcm
    }

    // stub to look forward or backward in the "xcmmessages" table
    async get_xcm_message_chain(msgHash, blockNumber, sentAt, dir = "parent", out = []) {
        out.push({
            msgHash,
            blockNumber,
            sentAt
        })
        // depending on "dir":
        //   (dir=child)  follow childMsgHash,  childSentAt  forward in time
        //   (dir=parent) follow parentMsgHash, parentSentAt backward in time
        let sql = `select ${dir}MsgHash, ${dir}SentAt, ${dir}Blocknumber from xcmmessages where incoming = 1 and msgHash = '${msgHash}' and blockNumber='${blockNumber}' limit 1`
        let xcmRecs = await this.poolREADONLY.query(sql);
        if (xcmRecs.length == 1) {
            let x = xcmRecs[0];
            let dirMsgHash = x[`${dir}MsgHash`];
            let dirSentAt = x[`${dir}SentAt`];
            let dirBlocknumber = x[`${dir}Blocknumber`];
            if (dirMsgHash != undefined && dirMsgHash.length > 0) {
                return this.get_xcm_message_chain(dirMsgHash, dirBlocknumber, dirSentAt, dir, out);
            }
        }
        return out;
    }
    async fetch_xcmmessages_chainpaths(sql) {
        let xcmRecs = await this.poolREADONLY.query(sql);
        let chainpaths = [];
        let xcmmessages = [];
        let sent = {};
        for (let r = 0; r < xcmRecs.length; r++) {
            let x = xcmRecs[r];
            x.paraID = paraTool.getParaIDfromChainID(x.chainID)
            x.paraIDDest = paraTool.getParaIDfromChainID(x.chainIDDest)
            x.msgHex = `${x.msgHex}`
            chainpaths.push({
                chainID: x.chainID,
                chainIDDest: x.chainIDDest,
                incoming: x.incoming,
                blockNumber: x.blockNumber,
                msgType: x.msgType
            });
            if (x.incoming == 1) {
                x.received = 1;
                x.sent = 0;
                x.blockNumberReceived = x.blockNumber;
                x.receivedTS = x.blockTS;
                xcmmessages.push(x);
            } else if (x.incoming == 0) {
                x.blockNumberSent = x.blockNumber
                x.sentTS = x.blockTS
                sent[x.msgHash] = x // this is used to mark .sent = 1 below
            }
        }
        // for all the msgHash keys in the sent map,  update "sent" attribute to 1 ... but if it can't be found then add it into the array
        for (const sentMsgHash of Object.keys(sent)) {
            let found = false;
            let x = sent[sentMsgHash]; //outgoing record
            for (let r = 0; r < xcmmessages.length; r++) {
                if (xcmmessages[r].msgHash == sentMsgHash) {
                    xcmmessages[r].sent = 1;
                    xcmmessages[r].parentMsgHash = x.parentMsgHash; // parentSentAt
                    xcmmessages[r].parentBlocknumber = x.parentBlocknumber; // parentBlocknumber
                    xcmmessages[r].parentSentAt = x.parentSentAt; // parentSentAt
                    xcmmessages[r].childMsgHash = x.childMsgHash; // childSentAt
                    xcmmessages[r].childBlocknumber = x.childBlocknumber; // childBlocknumber
                    xcmmessages[r].childSentAt = x.childSentAt; // childSentAt
                    xcmmessages[r].blockNumberSent = x.blockNumber
                    xcmmessages[r].sentTS = x.blockTS
                    xcmmessages[r].executedEventID = x.executedEventID
                    xcmmessages[r].destStatus = x.destStatus
                    xcmmessages[r].errorDesc = x.errorDesc

                    found = true;
                }
            }
            if (!found) {
                // somehow we don't have a "received" (incoming=1) record, so we'll add
                x.sent = 1;
                x.received = 0;
                x.blockNumberReceived = null // blockNumberReceived is unknown
                x.receivedTS = null
                xcmmessages.push(x);
            }
        }
        //console.log(`fetch_xcmmessages_chainpaths xcmmessages`, xcmmessages)
        //console.log(`fetch_xcmmessages_chainpaths chainpaths`, chainpaths)
        return [xcmmessages, chainpaths];
    }

    // for XCM messages not associated with an extrinsic:  link self, any parents + and children xcm messages together -- and get all those
    async get_xcm_messages_parents_children(x) {
        let out = []
        out.push(`( msgHash = '${x.msgHash}' and blockNumber = '${x.blockNumber}' )`);
        let parents = (x.parentMsgHash && x.parentMsgHash.length > 0) ? await this.get_xcm_message_chain(x.parentMsgHash, x.parentBlocknumber, x.parentSentAt, "parent", []) : [];
        let children = (x.childMsgHash && x.childMsgHash.length > 0) ? await this.get_xcm_message_chain(x.childMsgHash, x.childBlocknumber, x.childSentAt, "child") : [];
        // incoming = 0 is from sends (usually from traces), incoming = 1 is from event receives -- so we pick incoming=1 since traces are harder to get
        for (const p of parents) {
            out.push(`( msgHash = '${p.msgHash}' and blockNumber = '${p.blockNumber}' )`);
        }
        for (const p of children) {
            out.push(`( msgHash = '${c.msgHash}' and blockNumber = '${c.blockNumber}' )`);
        }
        let str = out.join(" or");
        let sql = `select chainID, chainIDDest, relayChain, blockTS, blockNumber, msgType, msgHash, msgHex, msgStr, assetChains, incoming, parentMsgHash, parentSentAt, parentBlocknumber, childMsgHash, childSentAt, childBlocknumber, version, executedEventID, destStatus, errorDesc from xcmmessages where ${str} order by blockTS, incoming`
        return this.fetch_xcmmessages_chainpaths(sql);
    }

    // get all the xcm messages associated with an extrinsicHash, and also return an array of chainpaths that have chainID/chainIDDest/incoming/blocknumber that allow us to fetch events/traces and formulate the timeline
    async get_xcm_messages_extrinsic(extrinsicHash) {
        let sql = `select chainID, chainIDDest, relayChain, blockTS, blockNumber, msgType, msgHash, msgHex, msgStr, assetChains, incoming, parentMsgHash, parentSentAt, parentBlocknumber, childMsgHash, childSentAt, childBlocknumber, assetsReceived, version, executedEventID, destStatus, errorDesc from xcmmessages where extrinsicHash = '${extrinsicHash}' order by blockTS, incoming`
        console.log(`get_xcm_messages_extrinsic sql=${sql}`)
        return this.fetch_xcmmessages_chainpaths(sql);
    }

    chainpaths_contains(chainpaths, chainID, blockNumber) {
        for (let i = 0; i < chainpaths.length; i++) {
            if (chainpaths[i].chainID == chainID && chainpaths[i].blockNumber == blockNumber) {
                return (true);
            }
        }
        return false
    }

    getSS58ByChainID(destAddress, chainID = 0) {
        let ss58Address = false
        if (!destAddress) return false
        if (destAddress.length == 42) {
            ss58Address = destAddress
        } else if (destAddress.length == 66) {
            let chainIDDestInfo = this.chainInfos[chainID]
            if (chainIDDestInfo.ss58Format != undefined) {
                ss58Address = paraTool.getAddress(destAddress, chainIDDestInfo.ss58Format)
            } else {
                ss58Address = paraTool.getAddress(destAddress, 42) // default
            }
        }
        return ss58Address
    }


    // given a hash of an extrinsic OR a XCM message hash, get the timeline of blocks and ALL xcmmessages we have indexed
    async getXCMTimeline(hash, hashType = "extrinsic", blockNumber = null, decorate = true, decorateExtra = true, advanced = true) {
        console.log("STEP1");
        let [decorateData, decorateAddr, decorateUSD, decorateRelated] = this.getDecorateOption(decorateExtra)
        try {
            let xcmmessages = [];
            let chainpaths = {};
            let extrinsicHash = null;
            let extrinsicID = null;
            if (hashType == "xcm") {
                // here we attempt to get the extrinsicHash of the xcmmessage so we an find all siblings
                let w = (blockNumber) ? ` and blockNumber = ${blockNumber}` : "" // because XCM messages hash aren't _perfectly_ unique, we need to have sentAt params disambiguate
                let sql = `select extrinsicID, extrinsicHash, blockNumber, parentMsgHash, parentSentAt, parentBlocknumber, childMsgHash, childSentAt, childBlocknumber, msgHash, sentAt, assetChains, incoming, version, executedEventID, destStatus, errorDesc from xcmmessages where msgHash = '${hash}' ${w} order by blockTS desc limit 1`
                let xcmscope = await this.poolREADONLY.query(sql);
                if (xcmscope.length == 1) {
                    let x = xcmscope[0];
                    if (x.extrinsicID && x.extrinsicHash && x.extrinsicID.length > 0 && x.extrinsicHash.length > 0) {
                        // if we have one XCM message linked to an extrinsicID/Hashwe can get them all!
                        // ALL the XCM messages related to extrinsic are fetched here ( A =m1=> B =m2=> C ) for the timeline of an extrinsicHash (hashType="extrinsic") OR all the sibling xcmmessages of a XCM msgHash (hashType="xcm")
                        extrinsicID = x.extrinsicID;
                        extrinsicHash = x.extrinsicHash;
                        [xcmmessages, chainpaths] = await this.get_xcm_messages_extrinsic(extrinsicHash);
                    } else {
                        // all we have is the single message, but we might have parents and/or children
                        [xcmmessages, chainpaths] = await this.get_xcm_messages_parents_children(x);
                    }
                } else {
                    throw new paraTool.NotFoundError(`XCM Record (type ${hashType}) not found: ${hash}`)
                }
            } else if (hashType == "extrinsic") {
                extrinsicHash = hash;
                //console.log(`getXCMTimeline type=extrinsic, hash=${extrinsicHash}`)
                [xcmmessages, chainpaths] = await this.get_xcm_messages_extrinsic(extrinsicHash);
            }

            // get eventIDs in assetsReceived, which may also contain additional chainpaths
            let eventIDs = [];
            xcmmessages.forEach((m) => {
                if (typeof m.executedEventID == "string" && (m.executedEventID.length > 0)) {
                    let a = m.executedEventID.split("-")
                    if (a.length == 4) { // eg 2-14077734-1-43
                        let e_chainID = parseInt(a[0], 10);
                        let e_blockNumber = parseInt(a[1], 10);
                        eventIDs.push(m.executedEventID);
                        console.log("HEY INCLUDING", e_chainID, e_blockNumber);
                        if (this.chainpaths_contains(chainpaths, e_chainID, e_blockNumber) == false) {
                            console.log("HEY INCLUDING in chainpaths", e_chainID, e_blockNumber);
                            chainpaths.push({
                                chainID: e_chainID,
                                chainIDDest: null,
                                incoming: -1,
                                blockNumber: parseInt(e_blockNumber, 10),
                                msgType: "none"
                            });
                        }

                    }
                }
                if (m.assetsReceived != undefined && m.assetsReceived.length > 0) {
                    try {
                        let assetsReceived = JSON.parse(m.assetsReceived);
                        assetsReceived.forEach((r) => {
                            if (r.eventID != undefined && r.eventID.length > 0) {
                                eventIDs.push(r.eventID);
                                // "eventID": "0-11411458-2-20"
                                let a = r.eventID.split("-");
                                if (a.length == 4) {
                                    // add to chainpaths: chainID, blockNumber -- because the xcmmatch processes detected an "assets:Issued" type event  for the beneficiary
                                    let [chainID, blockNumber, extrinsicNo, eventIndex] = a;
                                    if (this.chainpaths_contains(chainpaths, chainID, blockNumber) == false) {
                                        chainpaths.push({
                                            chainID: chainID,
                                            chainIDDest: null,
                                            incoming: -1,
                                            blockNumber: parseInt(blockNumber, 10),
                                            msgType: "none"
                                        });
                                    }
                                }
                            }
                        });
                    } catch (e) {

                    }
                }
            });

            console.log("STEP2");
            // build timeline
            let timeline = [];
            let coveredBlocks = {};
            for (let i = 0; i < chainpaths.length; i++) {
                let p = chainpaths[i];
                let chainID = p.chainID;
                let chainIDDest = p.chainIDDest;
                let bn_chainID = (p.incoming == 1) ? chainIDDest : chainID;
                let bnkey = `${bn_chainID}:${p.blockNumber}`
                if (coveredBlocks[bnkey] == undefined) {
                    coveredBlocks[bnkey] = 1;
                    let rRow = await this.fetch_block_row({
                        chainID: bn_chainID
                    }, p.blockNumber, ["autotrace", "blockraw", "feed", "finalized"]);
                    let paraID = paraTool.getParaIDfromChainID(chainID)
                    let paraIDDest = paraTool.getParaIDfromChainID(chainIDDest)
                    let filter = this.get_filter(paraID, paraIDDest, p.msgType, advanced);

                    let blockTS = rRow.feed.blockTS;
                    let [objects, extra] = this.filter_block_row_objects_and_msgHashes(rRow, filter, bn_chainID, extrinsicHash, eventIDs, p.blockNumber, blockTS);
                    if (objects && Array.isArray(objects) && objects.length > 0) {
                        let [_, id] = this.convertChainID(bn_chainID);
                        let chainName = this.getChainName(id);
                        timeline.push({
                            chainID: bn_chainID,
                            blockNumber: p.blockNumber,
                            blockTS,
                            id: id,
                            chainName: chainName,
                            objects,
                            extra
                        });
                    } else {
                        console.log("NO OBJECTS  chainID=", bn_chainID, "#", p.blockNumber);
                    }
                }
            }
            console.log("STEP3");
            // decorate the messages
            let decorated_xcmmessages = [];
            for (const m of xcmmessages) {
                let decorated_m = await this.decorateXCM(m, decorate, decorateExtra);
                decorated_xcmmessages.push(decorated_m);
                console.log(decorated_m);
            }
            return [timeline, decorated_xcmmessages];
        } catch (err) {
            console.log(err);
            return [
                [], {}
            ];
        }
    }
}
