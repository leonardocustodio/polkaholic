// Copyright 2022 Colorful Notion, Inc.
// This file is part of XCMScan

const Query = require("../../polkaholic/substrate/query");
const mysql = require("mysql2");
const fs = require("fs");
const paraTool = require("../../polkaholic/substrate/paraTool");
const util = require('util');
const path = require('path');

var {
    ApiPromise,
    WsProvider
} = require('@polkadot/api');
var {
    encodeAddress,
    decodeAddress
} = require('@polkadot/util-crypto');
var {
    hexToU8a,
    stringToU8a,
    u8aToHex,
    isHex
} = require('@polkadot/util')

module.exports = class Onfinality extends Query {
    async onfinality_list_nodes(useCurl = false) { //https://doc.onfinality.io/#operation/NodeV2Controller-list
        try {
            //let cmd = `curl -sk -H "Authorization: Bearer ${bearerToken}" "https://api.onfinality.io/api/v2/workspaces/${wsID}/nodes"`
            let cmd = `onf node list -o json`;
            const {
                stdout,
                stderr
            } = await exec(cmd);
            let nodeList = JSON.parse(stdout);
            console.log("onfinality_list_nodes: ");
            nodeList.map((n) => {
                var sql = `update chain set onfinalityID = '${n.id}', onfinalityStatus = '${n.status}', onfinalityConfig = ` + mysql.escape(JSON.stringify(n)) + ` where chainName = '${n.name}' or id = '${n.name}'`;
                console.log(sql);
                this.batchedSQL.push(sql);
            })
            await this.update_batchedSQL();
            return nodeList;
        } catch (err) {
            this.logger.error({
                "op": "onfinality_list_nodes",
                err
            })
            console.log(err);
        }
        return (false);
    }

    async onfinality_get_node(id) {
        //let cmd = `curl -sk -H "Authorization: Bearer ${bearerToken}" "https://api.onfinality.io/api/v2/workspaces/${wsID}/nodes/${id}"`
        let cmd = `onf node  show -n ${id} -o json`
        const {
            stdout,
            stderr
        } = await exec(cmd);
        console.log(cmd, stdout);
        let nodeRaw = JSON.parse(stdout);
        let nodeInformation = nodeRaw.Information;
        let nodeEndpoints = nodeRaw.Endpoints;
        let n = {}

        nodeInformation.forEach((kv) => {
            let k = kv.Key;
            let v = kv.Value;
            if (k == 'ID:') {
                n.id = id;
            } else if (k == "Name:") {
                n.name = v;
            } else if (k == "Status:") {
                n.status = v;
            } else if (k == "Storage Size:") {
                n.storageSize = v;
            } else if (k == "Image:") {
                n.image = v;
            } else if (k == "Network:") {
                n.network = v;
            } else if (k == "Cluster:") {
                n.cluster = v;
            } else if (k == "Node Size:") {
                n.nodeSize = v;
            }
        });
        nodeEndpoints.forEach((kv) => {
            let k = kv.Key;
            let v = kv.Value;
            if (k == 'HTTPs') {
                n.RPCBackfill = v;
            } else if (k == "Websocket") {
                n.WSBackfill = v;
            }
        });

        var sql = `update chain set onfinalityStatus = '${n.status}', RPCBackfill = ` + mysql.escape(n.RPCBackfill) + `, WSBackfill = ` + mysql.escape(n.WSBackfill) + ` where chainName = '${n.name}' or id = '${n.name}'`;
        console.log(sql);
        this.batchedSQL.push(sql);
        await this.update_batchedSQL();
        return (n);
    }

    // possible node action: stop/resume
    async onfinality_node_action(id, action = "stop", name = "unk") { // https://doc.onfinality.io/#operation/53046886-e15a-4200-9baf-441f76aef1a2
        //let cmd = `curl -sk -X POST -H "Authorization: Bearer ${bearerToken}" "https://api.onfinality.io/api/v2/workspaces/${wsID}/nodes/${id}/${action}"`
        let cmd = `onf node ${action} -n ${id}`
        const {
            stdout,
            stderr
        } = await exec(cmd);

        console.log(`onfinality_node_action (${name} => ${id}):`, action, stdout, stderr);
        console.log(cmd);
    }

    async activateRPCBackfill(chain) {
        let done = false;
        do {
            let n = await this.onfinality_get_node(chain.onfinalityID);
            console.log("activateRPCBackfill", n.id, n.status)
            switch (n.status) {
                case "terminated":
                    process.exit(1);
                    break;
                case "stopped":
                case "stopping":
                    await this.onfinality_node_action(n.id, "resume", chain.chainName)
                    break;
                case "running":
                    console.log("activateRPCBackfill ... node RUNNING!")
                    done = true;
                    break;
                case "initializing":
                default:
                    console.log("activateRPCBackfill", n.status);
                    break;
            }
            if (!done) {
                await this.sleep(1000);
            }
        } while (!done);
        // check for "Synced" ... otherwise getting traces will fail
        await this.setupAPI(chain, true);
        done = false;
        let startTS = new Date().getTime(); // used to compute elapsedTS
        do {
            try {
                let finalizedBlockHash = await this.api.rpc.chain.getFinalizedHead();
                let finalizedHeader = await this.api.rpc.chain.getHeader(finalizedBlockHash);
                let bn = finalizedHeader.number ? paraTool.dechexToInt(finalizedHeader.number) : 0
                if (bn >= chain.blocksFinalized) {
                    console.log("activateRPCBackfill SYNCED!!!", bn, ">=", chain.blocksFinalized);
                    return (true);
                } else {
                    let elapsedSeconds = Math.floor((new Date().getTime() - startTS) / 1000)
                    console.log("activateRPCBackfill NOT SYNCED ... ", bn, "<", chain.blocksFinalized, `(${elapsedSeconds}s)`);
                    if (elapsedSeconds > 30 && (chain.blocksFinalized - bn) > 1000 || (elapsedSeconds > 60)) {
                        console.log("... terminating... come back to it later!");
                        return (false);
                    }
                    await this.sleep(2000);
                }
            } catch (err) {
                console.log(err);
            }
        } while (!done)
    }

    async deactivateRPCBackfill(chain) {
        console.log("NOT DOING THIS!");
        return (false);
        let done = false;
        do {
            let n = await this.onfinality_get_node(chain.onfinalityID);
            switch (n.status) {
                case "stopped":
                    console.log("deactivateRPCBackfill ... node STOPPED!")
                    done = true;
                    break;
                case "initializing":
                case "running":
                    //console.log("deactivateRPCBackfill", n.status);
                    //   await this.onfinality_node_action(n.id, "stop", chain.chainName)
                    break;
                default:
                    console.log("deactivateRPCBackfill", n.status);
                    break;
            }
            if (!done) {
                await this.sleep(1000);
            }
        } while (!done);
    }


    // for any missing traces, this refetches the dataset
    async crawlTraces(chainID, techniqueParams = ["mod", 0, 1], lookback = 1000) {
	let chain = await this.setupChainAndAPI(chainID);
	let done = false;

	do {
	    let numRecentCrawlTraces = await this.getNumRecentCrawlTraces(chain, lookback);
	    console.log("crawlTraces numRecentCrawlTraces=", numRecentCrawlTraces)

	    if (chain.WSEndpointSelfHosted == 1) {

	    } else {
		let n = await this.onfinality_get_node(chain.onfinalityID);
		if (numRecentCrawlTraces < minCrawlTracesToActivateRPCBackfill) {
		    //await this.deactivateRPCBackfill(chain);
		    return (false);
		}
		let res = await this.activateRPCBackfill(chain);
		if (res == false) {
		    // this means we failed to sync
		    return (false);
		}
	    }

	    let sql = `select blockNumber, UNIX_TIMESTAMP(blockDT) as blockTS, blockHash, attempted from block${chainID} where crawlTrace > 0 and length(blockHash) > 0 and blockDT >= date_sub(Now(), interval ${lookback} DAY) and attempted < ${maxTraceAttempts} and blockNumber % ${techniqueParams[2]} = ${techniqueParams[1]} order by crawlTrace desc,attempted, numSignedExtrinsics desc, blockNumber desc limit 10000`
	    if (techniqueParams[0] == "range") {
		let startBN = techniqueParams[1];
		let endBN = techniqueParams[2];
		sql = `select blockNumber, UNIX_TIMESTAMP(blockDT) as blockTS, blockHash, attempted from block${chainID} where crawlTrace > 0 and length(blockHash) > 0 and blockNumber >= ${startBN} and blockNumber <= ${endBN} and attempted < ${maxTraceAttempts} order by blockNumber limit 10000`
	    }
	    console.log(sql);
	    let tasks = await this.poolREADONLY.query(sql);

	    let jmp = 4;
	    for (var i = 0; i < tasks.length; i += jmp) {
		let j = i + jmp;
		if (j > tasks.length) j = tasks.length;
		let pieces = tasks.slice(i, j);
		let res = pieces.map((t1) => {
		    let t2 = {
			chainID: chainID,
			blockNumber: t1.blockNumber,
			blockHash: t1.blockHash,
			blockTS: t1.blockTS,
			attempted: t1.attempted
		    };
		    return this.crawl_trace(chain, t2);
		});
		let res2 = await Promise.all(res);
		res2.forEach(async (t_trace) => {
		    let [t, trace] = t_trace;
		    if (trace && (trace.length > 0)) {
			let sql = `update block${chainID} set crawlTrace = 0 where blockNumber = ${t.blockNumber}`
			this.mark_indexlog_dirty(chainID, t.blockTS)
			this.batchedSQL.push(sql)
		    } else {
			let sql = `update block${chainID} set attempted = attempted + 1 where blockNumber = ${t.blockNumber}`
			this.batchedSQL.push(sql)
		    }
		    return
		});
		this.batchedSQL.push(`update chain set traceTSLast = UNIX_TIMESTAMP(Now()) where chainID = ${chainID}`)
		await this.update_batchedSQL();
	    }
	    if (numRecentCrawlTraces < 3) done = true;
	} while (!done);

    }

}
