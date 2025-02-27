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

const paraTool = require('./paraTool');
const {
    u8aToHex,
} = require("@polkadot/util");
var util_crypto_1 = require("@polkadot/util-crypto");

const assetChainSeparator = "~" // TODO: redundant, get from paraTool instead

function currency_format(c, priceUSD = false, priceUSDCurrent = false, isDefaultOriginal = true) {
    if (isNaN(c)) {
        return `NA`
    }
    let _m = 2;
    if (c > 100000) _m = 0;
    if (c < .1) _m = 3;
    if (c < .01) _m = 4;
    var formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: _m
    });
    if (priceUSD && priceUSDCurrent && priceUSD > 0 && priceUSDCurrent > 0) {
        let originalUSD = formatter.format(c);
        let currentUSD = formatter.format(c * (priceUSDCurrent / priceUSD));
        if (isDefaultOriginal) {
            //present original USD as default value
            let msgTitle = "Displaying value at the time of Txn; Click to show current value"
            return `<button type="button" class="btn btn-link" style="font-size:0.9rem;font-style:normal; padding:unset" currency="usd" original="0"  originalUSD="${originalUSD}" currentUSD="${currentUSD}" data-mdb-placement="right" title="${msgTitle}" >${originalUSD}</button>`
        } else {
            //present current USD as default value
            let msgTitle = "Displaying current value; Click to show value are the time of Txn"
            return `<button type="button" class="btn btn-link" style="font-size:0.9rem;font-style:normal; padding:unset" currency="usd" original="1"  originalUSD="${originalUSD}" currentUSD="${currentUSD}" data-mdb-placement="right" title="${msgTitle}" >${currentUSD}</button>`
        }
    }
    return formatter.format(c);
}

function round(value, decimals = 2) {
    return Number(Math.round(value + 'e' + decimals) + 'e-' + decimals);
}

function presentPercentage(val, decimals = 2) {
    let value = val * 100
    let n = Number(Math.round(value + 'e' + decimals) + 'e-' + decimals);
    return `${n}%`
}


function timeSince(seconds) {
    var interval = seconds / 86400;
    if (interval >= 1) {
        let days = Math.floor(interval)
        let pl = (days > 1) ? "s" : ""
        return days + " day" + pl;
    }
    interval = seconds / 3600;
    if (interval > 1) {
        let hours = Math.floor(interval);
        let pl = (hours > 1) ? "s" : ""
        return hours + " hour" + pl;
    }
    interval = seconds / 60;
    if (interval > 1) {
        let minutes = Math.floor(interval);
        let pl = (minutes > 1) ? "s" : "";
        return minutes + " minute" + pl;
    }
    return Math.floor(seconds) + " seconds";
}


function present_parachain(parachain) {
    switch (parachain) {
        case 2000:
            return "Kusama"
            break;
        case 2001:
            return "Karura"
            break;
        default:
            return "Parachain " + parachain;
            break;
    }
}

function hex2a(str) {
    const buf = new Buffer.from(str, 'hex');
    return buf.toString('utf8');
}

function get_short_hash(hash) {
    if (hash) {
        if (hash.length >= 30) {
            return `<code>${hash.substr(0,8)}...${hash.substr(-6)}</code>`;
        } else {
            return `<code>${hash}</code>`;
        }
    }
    return "-";
}

function get_full_hash(hash) {
    if (hash) {
        return `<code>${hash}</code>`
    }
    return "-";
}

function copyToClipboard(inp) {
    const clipboardIcon = '<i class="fa-regular fa-copy"></i>';
    return "<a href='javascript:copyToClipboard(\"" + inp + "\")'>" + clipboardIcon + "</a>";
}

function tx_link_with_desc(link, desc, allowCopy = true) {
    let out = `<a href='/tx/${link}'>` + get_short_hash(desc) + `</a>`;
    if (allowCopy) out += copyToClipboard(desc);
    return out;
}

function tx_link(id, allowCopy = true) {
    let out = `<a href='/tx/${id}'>` + get_short_hash(id) + `</a>`;
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function tx_link_full(id, allowCopy = true) {
    let out = `<a href='/tx/${id}'>` + id + `</a>`;
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function erc_token_link(id, assetInfo, allowCopy = false) {
    let assetChain = (assetInfo != undefined && assetInfo.assetChain != undefined) ? assetInfo.assetChain : false
    let symbol = (assetInfo != undefined && assetInfo.symbol != undefined) ? assetInfo.symbol : false
    if (!assetChain && !symbol) {
        return '-'
    }
    let out = '<a href="/asset/' + encodeURIComponent(assetChain) + '">' + symbol + '</a>';
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function account_link(id, allowCopy = true, shortHash = true) {
    let accountID = paraTool.getPubKey(id);
    let h = shortHash ? get_short_hash(id) : id;
    let out = `<a href='/account/${accountID}'>` + h + `</a>`;
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function address_link(id, allowCopy = true, shortHash = true) {
    let h = shortHash ? get_short_hash(id) : id;
    let out = `<a href='/address/${id}'>` + h + `</a>`;
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function account_link_full(id, allowCopy = true) {
    let accountID = paraTool.getPubKey(id);
    let out = `<a href='/account/${accountID}'>` + id + `</a>`;
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function address_link_full(id, allowCopy = true) {
    let out = `<a href='/address/${id}'>` + id + `</a>`;
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function present_id_row(row, fld) {
    if (row[fld] == undefined) return "";

    let id = row[fld];
    let res = '<a href="/account/' + id + '">' + id + '</a>';
    let hit = null;
    if (row[fld + "Address"] != undefined) {
        hit = fld + "Address";
    } else if (row[fld] != undefined) {
        hit = fld;
    }
    if (hit != null) {
        if (row[hit + "_nickname"] != undefined) {
            res += "<BR>" + row[hit + "_nickname"]
        } else if (row[hit + "_info"] != undefined) {
            try {
                let info = row[hit + "_info"];
                if (info.display != undefined) {
                    res += "<BR>" + info.display;
                }
            } catch (err) {
                console.log("present_id_row err", err, row)
            }
        }
    }
    return res;
}

function present_topic(id, allowCopy = true) {
    let out = get_short_hash(id);
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function present_raw_data(id, allowCopy = true) {
    let out = get_short_hash(id);
    if (allowCopy) out += copyToClipboard(id);
    return out;
}

function ts_to_logDT_hr(ts) {
    var a = new Date(ts * 1000);
    let dd = a.getUTCDate().toString().padStart(2, '0');
    let mm = String(a.getUTCMonth() + 1).padStart(2, '0'); //January is 0!
    let yyyy = a.getUTCFullYear();
    let logDT = `${yyyy}-${mm}-${dd}`;
    var hr = a.getUTCHours();
    return [logDT, hr];
}

function present_dests(ids) {
    let res = []
    if (!ids) return res;
    for (const d of ids) {
        if (d.id) {
            res.push(d.id)
        }
    }
    return res
}

function parse_token_asset(rAsset) {
    let asset = {}
    for (const k of Object.keys(rAsset)) {
        asset[capitalizeFirstLetter(k)] = rAsset[k]
    }
    if (asset.Token) {
        return asset.Token;
    } else if (asset.ForeignAsset) {
        switch (asset.ForeignAsset) {
            case "0":
                return "RMRK";
            default:
                return "ForeignAsset:" + asset.ForeignAsset;
        }
    } else if (asset.LiquidCrowdloan) {
        switch (asset.LiquidCrowdloan) {
            case 13:
            case "13":
                return "lcDOT";
                break;
            default:
                return "ACALA(" + asset.LiquidCrowdloan + ")";
        }
    } else if (Array.isArray(rAsset)) {
        let tok0 = parse_token_asset(rAsset[0]);
        let tok1 = parse_token_asset(rAsset[1]);
        return tok0 + "/" + tok1;
    }
    return JSON.stringify(rAsset);
}

function camel2title(camelCase) {
    // no side-effects
    return camelCase
        // inject space before the upper case letters
        .replace(/([A-Z])/g, function(match) {
            return " " + match;
        })
        // replace first char with upper case
        .replace(/^./, function(match) {
            return match.toUpperCase();
        });
}

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function show_account_info(c, fld) {
    try {
        if (c[fld] == undefined) return ("");
        if (c[fld + "_nickname"] != undefined) {
            return (c[fld + "_nickname"]);
        }
        if (c[fld + "_subIdentityName"] != undefined) {
            return (c[fld + "_subIdentityName"]);
        }
        if (c[fld + "_info"] != undefined) {
            let info = c[fld + "_info"];
            return (info.display);
        }
    } catch (err) {
        console.log(err);
    }
}

module.exports = {
    currencyFormat: function(c, _maximumFractionDigits = 2) {
        if (c < .01) _maximumFractionDigits = 3;
        if (c < .001) _maximumFractionDigits = 43;
        var formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: _maximumFractionDigits
        });
        return formatter.format(c);
    },
    presentPercentChange: function(p) {
        return p + "%"; // TODO: improve this
    },
    presentPercentage: function(n, decimals = 2) {
        return presentPercentage(n, decimals)
    },
    presentCurrency: function(c) {
        if (c.token) {
            return c.token
        }
        return (JSON.stringify(c));
    },
    presentRemark: function(c) {
        return (hex2a(c.substr(2)));
    },
    presentAmount: function(a, decimal = 12) {
        let val = paraTool.dechexToInt(a)
        let amt = val / 10 ** decimal;
        return (amt.toString());
    },
    presentNumber: function(a) {
        if (a == undefined || (!a)) return ("-");
        if (a >= 1000000000000) {
            let amt = a / 1000000000000;
            return (new Intl.NumberFormat('en-IN', {
                maximumSignificantDigits: 3
            }).format(amt) + "T");
        }
        if (a >= 1000000000) {
            let amt = a / 1000000000;
            return (new Intl.NumberFormat('en-IN', {
                maximumSignificantDigits: 3
            }).format(amt) + "B");
        }
        if (a >= 1000000) {
            let amt = a / 1000000;
            return (new Intl.NumberFormat('en-IN', {
                maximumSignificantDigits: 3
            }).format(amt) + "M");
        }
        if (a >= 1000) {
            let amt = a / 1000;
            return (new Intl.NumberFormat('en-IN', {
                maximumSignificantDigits: 3
            }).format(amt) + "K");
        }
        return (a.toString());
    },
    presentFloat: function(a, decplaces = 5) {
        let amt = a.toFixed(decplaces);
        return (amt.toString());
    },
    presentPath: function(p) {
        if (Array.isArray(p)) {
            let tokens = p.map((piece) => {
                if (piece.token) {
                    return piece.token;
                } else {
                    return "unk";
                }
            });
            return tokens.join(" -> ");
        }
        return (JSON.stringify(p));
    },
    presentInfo: function(p) {
        let attrs = ["display", "legal", "web", "riot", "email", "image", "twitter"];
        for (var i = 0; i < attrs.length; i++) {
            if (p[attrs[i]]) {
                return hex2a(p[attrs[i]].raw.substr(2));
            }
        }
    },
    presentTx: function(id) {
        return tx_link(id)
    },
    presentFullTx: function(id) {
        return tx_link_full(id)
    },
    presentERCToken: function(id, assetInfo) {
        return erc_token_link(id, assetInfo)
    },
    presentExtrinsicID: function(extrinsicHash, extrinsicID) {
        return tx_link_with_desc(extrinsicHash, extrinsicID)
    },
    presentID: function(id, shortHash = false) {
        if (shortHash) {
            return account_link(id)
        } else {
            return account_link_full(id)
        }
    },
    presentAddress: function(id, shortHash = false) {
        if (shortHash) {
            return address_link(id)
        } else {
            return address_link_full(id)
        }
    },
    presentFullID: function(id) {
        return account_link_full(id)
    },
    presentIDs: function(ids) {
        try {
            let account_links = ids.map((id) => {
                return account_link_full(id);
            });
            return `[${account_links.join(" , ")}]`;
        } catch (e) {}!no

    },
    beautifyCamelCase: function(str) {
        return capitalizeFirstLetter(camel2title(str).trim())
    },
    presentDest: function(d) {
        if (!d) return JSON.stringify("");
        try {
            if (d.id) {
                return d.id
            } else if (d.v0) { // {"v0":{"x1":{"parachain":"2000"}}}
                if (d.v0.x1 && d.v0.x1.parachain) {
                    return present_parachain(d.v0.x1.parachain);
                }
            } else if (d.v1) { //  {"v1":{"parents":0,"interior":{"x1":{"parachain":2001}}}}
                if (d.v1.interior && d.v1.interior.x1 && d.v1.interior.x1.parachain) {
                    return present_parachain(d.v1.interior.x1.parachain);
                }
            }
        } catch (e) {
            console.log(e);
        }
        return (JSON.stringify(d));
    },
    presentDests: function(ids) {
        return present_dests(ids)
    },
    presentSearchResult: function(r) {
        return `<p><a href='${r.link}'>` + r.text + "</a><br>" + r.description + "</p>";
    },
    presentAsset: function(asset, chainID, symbol, assetName = false) {
        let assetChain = asset + assetChainSeparator + chainID;
        let assetText = assetName ? assetName : symbol;
        return '<a href="/asset/' + encodeURIComponent(assetChain) + '">' + assetText + '</a>';
    },
    presentAssetPair: function(assetChain, symbol, asset0, asset1, symbol0, symbol1, chainID) {
        let assetPair = symbol + ":" + asset0.substring(0, 6) + "/" + asset1.substring(0, 6);
        let assetChain0 = asset0 + assetChainSeparator + chainID;
        let assetChain1 = asset1 + assetChainSeparator + chainID;
        return '<a href="/asset/' + encodeURIComponent(assetChain0) + '">' + symbol0 + '</a> / <a href="/asset/' + encodeURIComponent(assetChain1) + '">' + symbol1 + '</a> (<a href="/asset/' + encodeURIComponent(assetChain) + '">' + assetPair + '</a>)';
    },
    presentAssetPairChart: function(assetChain) {
        return '<a href="/chart/' + encodeURIComponent(assetChain) + '">Chart</a>';
    },
    presentAssets: function(a) {
        if (a.v1) { // {"v1":[{"id":{"concrete":{"parents":0,"interior":{"here":null}}},"fun":{"fungible":7694181620528}}]}
            if (a.v1.length > 0) {
                if (a.v1[0].id && a.v1[0].fun && a.v1[0].fun.fungibleamount) {
                    let amt = a.v1[0].id.fun.fungibleamount;
                    return amt;
                }
            }

        } else if (a.v0) { // {"v0":[{"concreteFungible":{"id":{"null":null},"amount":25567000000000}}]}
            if (a.v0.length > 0) {
                let amt = a.v0[0].concreteFungible.amount;
                return amt;
            }
        }
        return (JSON.stringify(a));
    },
    presentBlock: function(chainID, bn) {
        return `<a href='/block/${chainID}/${bn}'>${bn}</a>`
    },
    presentTrace: function(chainID, bn, blockHash) {
        return `<a href='/trace/${chainID}/${bn}/${blockHash}'>Trace ${bn}</a>`
    },
    presentSecondsAgoTS: function(ts) {
        let now = Math.floor(new Date().getTime() / 1000);
        let secondsago = now - ts;
        if (secondsago < 0) secondsago = 0;
        return timeSince(secondsago) + " ago";
    },
    getRecentDateRange: function(daysago = 7) {
        let now = Math.floor(new Date().getTime() / 1000);
        let [startDate, _] = ts_to_logDT_hr(now - daysago * 86400);
        let [endDate, __] = ts_to_logDT_hr(now);
        return [startDate, endDate];
    },
    presentTS: function(ts) {
        let res = new Date(ts * 1000).toISOString().replace(/T/, ' ').replace(/\..+/, '');
        res += " (+UTC)";
        return res;
    },
    presentChain: function(chainID, chainName) {
        return `<a href='/chain/${chainID}'>` + chainName + `</a>`;
    },
    presentSpecVersion: function(chainID, specVersion) {
        return `<a href='/specversion/${chainID}/${specVersion}'>` + specVersion + `</a>`;
    },
    presentTopic: function(t) {
        return present_topic(t);
    },
    presentRawData: function(t) {
        return present_raw_data(t);
    },
    presentMS: function presentMS(ms) {
        return new Date(parseInt(ms, 10)).toISOString();
    },
    presentTokenAsset: function(asset) {
        return parse_token_asset(asset);
    },
    presentCopyToClipboardId: function(inp) {
        const clipboardIcon = '<i class="fa-regular fa-copy"></i>';
        return "<a href='javascript:copyToClipboardId(\"" + inp + "\")'>" + clipboardIcon + "</a>";
    },
    presentTokenAttribute: function(t, attr) {
        let str = "";
        if (t[attr] > 0) {
            str = attr + ": " + (Math.round(t[attr] * 100000) / 100000);
            let v = t[attr + "USD"];
            if (v && v > 0) {
                str = str + " (" + currency_format(v) + ")";
            }
        }
        return str;
    },
    validPassword: function(p) {
        try {
            return (p.length > 6);
        } catch (e) {
            return (false);
        }
        return (false);
    },
    validEmail: function(emailToValidate) {
        //const emailRegexp = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        //return (emailRegexp.test(emailToValidate));
        return (true);
    },
    camelize: function(inp) {
        let sa = inp.replaceAll("_", " ").split(" ");
        let r = sa.map((w, i) => {
            if (i == 0) {
                return w.toLowerCase();
            } else {
                return w.substr(0, 1).toUpperCase() + w.substr(1);
            }
        })
        let o = r.join("");
        return (o);
    },
    capitalizeFirstLetter: function(inp) {
        return capitalizeFirstLetter(inp)
    },
    currencyFormat: function(c, priceUSD = false, priceUSDCurrent = false) {
        return currency_format(c, priceUSD, priceUSDCurrent);
    },
    getShortHash: function(hash, shortHash = true, allowCopy = true) {
        let out = shortHash ? get_short_hash(hash) : hash;
        if (allowCopy && hash != null && (typeof hash == "string") && (hash.length > 0)) {
            out += copyToClipboard(hash);
        }
        return out;
    },
    getEVMMethod: function(sig) {
        let out = sig.split("(");
        return capitalizeFirstLetter(out[0]);
    },
    getFullHash: function(hash, allowCopy = true) {
        let out = get_full_hash(hash);
        if (allowCopy) {
            out += copyToClipboard(hash);
        }
        return out;
    },
    blake2: function(inp) {
        var blake2 = function(value) {
            return util_crypto_1.blake2AsU8a(value, 512);
        };
        return u8aToHex(blake2(inp))
    },
    isJSONString: function(x) {
        if (typeof x != "string") return (false);
        let l = x.length;
        if (x.length < 2) return (false);
        if (x.charAt(0) == "{" && x.charAt(l - 1) == "}") return (true);
        if (x.charAt(0) == "[" && x.charAt(l - 1) == "]") return (true);
        return (false);
    },
    showAccountInfo: function(c, fld) {
        return show_account_info(c, fld);
    },
    presentIDRow: function(row, fld) {
        return present_id_row(row, fld)
    },
    getTimelineRows: function(timeline) {
        return timeline.map((t) => {
            return [t.id, t.blockNumber.toString(), t.blockTS, t.blockTS + 6, t.objects, t.extra]
        });
    },
    getPublicWSEndpoints: function(chain) {
        let endpoints = [];
        if (chain.WSEndpoint && chain.WSEndpoint.length > 0 && !chain.WSEndpoint.includes("polkaholic.io")) {
            endpoints.push(chain.WSEndpoint);
        }
        if (chain.WSEndpoint2 && chain.WSEndpoint2.length > 0 && !chain.WSEndpoint2.includes("polkaholic.io")) {
            endpoints.push(chain.WSEndpoint2);
        }
        if (chain.WSEndpoint3 && chain.WSEndpoint3.length > 0 && !chain.WSEndpoint3.includes("polkaholic.io")) {
            endpoints.push(chain.WSEndpoint3);
        }
        return endpoints;
    },
    verifierEnabled: function() {
	return false;
    }
};
