const mysql = require("mysql2");
const paraTool = require("../paraTool");
const uiTool = require("../uiTool");
const ChainParser = require("./chainparser");

module.exports = class ParallelParser extends ChainParser {

    constructor() {
        super()
    }

    tokenID_to_string(t) {
        return t.replaceAll(",", "");
    }

    // default parser
    processIncomingXCM(indexer, extrinsic, extrinsicID, events, finalized = false) {
        return super.processIncomingXCM(indexer, extrinsic, extrinsicID, events, finalized)
    }

    processOutgoingXCM(indexer, extrinsic, feed, fromAddress, section = false, method = false, args = false) {
        let module_section = section;
        let module_method = method
        if (section == false && section == false) {
            module_section = extrinsic.section;
            module_method = extrinsic.method;
            args = extrinsic.params
        }
        let section_method = `${module_section}:${module_method}`
        //let outgoingXcmList = [];
        if (args.calls != undefined) { // this is an array
            //console.log(`[${extrinsic.extrinsicID}] descend into calls`, args.calls.length)
            let i = 0;
            for (const c of args.calls) {
                let call_section = c.section;
                let call_method = c.method;
                let c_args = c.args
                //console.log(`[${extrinsic.extrinsicID}] call`, i, call_section, call_method, c);
                i++;
                this.processOutgoingXCM(indexer, extrinsic, feed, fromAddress, call_section, call_method, c_args)
            }
        } else if (args.call != undefined) { // this is an object
            let call = args.call
            let call_args = call.args
            let call_section = call.section;
            let call_method = call.method;
            let isHexEncoded = (typeof call === 'object') ? false : true
            //console.log(`[${extrinsic.extrinsicID}] descend into call`, call)
            if (!isHexEncoded && call_args != undefined) {
                this.processOutgoingXCM(indexer, extrinsic, feed, fromAddress, call_section, call_method, call_args)
            }
        }
        switch (module_section) {
            case 'xTokens':
                let outgoingXcmList1 = this.processOutgoingXTokens(indexer, extrinsic, feed, fromAddress, section_method, args)
                if (this.debugLevel >= paraTool.debugInfo) console.log(`parallel processOutgoingXCM xTokens`, outgoingXcmList1)
                //return outgoingXcmList
                break;
            case 'xcmPallet':
                let outgoingXcmList2 = this.processOutgoingXcmPallet(indexer, extrinsic, feed, fromAddress, section_method, args)
                if (this.debugLevel >= paraTool.debugInfo) console.log(`parallel processOutgoingXcmPallet xcmPallet`, outgoingXcmList2)
                //return outgoingXcmList
                break;
            case 'polkadotXcm':
                let outgoingXcmList3 = this.processOutgoingPolkadotXcm(indexer, extrinsic, feed, fromAddress, section_method, args)
                if (this.debugLevel >= paraTool.debugInfo) console.log(`parallel processOutgoingXCM polkadotXcm`, outgoingXcmList3)
                //return outgoingXcmList
                break;
            default:
                //console.log(`unknown`)
                //return outgoingXcmList
                break;
        }
    }


    processOutgoingXTokens(indexer, extrinsic, feed, fromAddress, section_method, args) {
        // need additional processing for currency_id part
        /*
        "params": {
          "currency_id": 101,
        */
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel processOutgoingXTokens start`)
        let assetString = false
        let a = args
        if (a.currency_id != undefined) {
            assetString = this.processDecHexCurrencyID(indexer, a.currency_id)
        }
        //let generalOutgoingXcmList = super.processOutgoingXTokens(indexer, extrinsic, feed, fromAddress)
        super.processOutgoingXTokens(indexer, extrinsic, feed, fromAddress, section_method, args)
        let generalOutgoingXcmList = (extrinsic.xcms != undefined) ? extrinsic.xcms : []
        let outgoingXcmList = []
        for (var xcmtransfer of generalOutgoingXcmList) {
            if (xcmtransfer == undefined) {
                if (this.debugLevel >= paraTool.debugErrorOnly) console.log(`parallel processOutgoingXTokens xcmPallet missing`)
            } else if (assetString) {
                xcmtransfer.asset = assetString
                outgoingXcmList.push(xcmtransfer)
            } else {
                if (this.debugLevel >= paraTool.debugErrorOnly) console.log(`parallel processOutgoingXTokens xcmPallet assetString missing`)
                outgoingXcmList.push(xcmtransfer)
            }
        }
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel processOutgoingXTokens DONE`, outgoingXcmList)
        extrinsic.xcms = outgoingXcmList
        return outgoingXcmList
    }

    processOutgoingXcmPallet(indexer, extrinsic, feed, fromAddress, section_method, args) {
        // need additional processing for currency_id part
        /*
        "params": {
          "currency_id": 101,
        */
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel processOutgoingXcmPallet start`)
        let assetString = false
        let a = args
        if (a.currency_id != undefined) {
            assetString = this.processDecHexCurrencyID(indexer, a.currency_id)
        }
        //let generalOutgoingXcmList = super.processOutgoingXcmPallet(indexer, extrinsic, feed, fromAddress)
        super.processOutgoingXcmPallet(indexer, extrinsic, feed, fromAddress, section_method, args)
        let generalOutgoingXcmList = (extrinsic.xcms != undefined) ? extrinsic.xcms : []
        let outgoingXcmList = []
        for (var xcmtransfer of generalOutgoingXcmList) {
            if (xcmtransfer == undefined) {
                if (this.debugLevel >= paraTool.debugErrorOnly) console.log(`parallel processOutgoingXcmPallet xcmPallet missing`)
            } else if (assetString) {
                xcmtransfer.asset = assetString
                outgoingXcmList.push(xcmtransfer)
            } else {
                if (this.debugLevel >= paraTool.debugErrorOnly) console.log(`parallel processOutgoingXcmPallet assetString missing`)
                outgoingXcmList.push(xcmtransfer)
            }
        }
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel processOutgoingXcmPallet DONE`, outgoingXcmList)
        extrinsic.xcms = outgoingXcmList
        return outgoingXcmList
    }

    async getAssetDecimal(indexer, asset, ctx) {
        // IMPORTANT: ALWAYS USE decimal from getAssetInfo. this ensure we lookup for missing assetName, deciamls and etc
        /*
        let res = indexer.getAssetDecimal(asset, indexer.chainID, ctx);
        if (res) {
            console.log(`getAssetDecimal res found`, asset, indexer.chainID, res)
            return (res);
        }
        */
        let parsedAsset = JSON.parse(asset);
        let assetInfo = await this.getAssetInfo(indexer, parsedAsset);
        if (assetInfo && assetInfo.decimals) {
            return assetInfo.decimals;
        }
        return (false);
    }

    async getAssetInfo(indexer, parsedAsset) {
        var asset = JSON.stringify(parsedAsset);
        //console.log(`getAssetInfo `, parsedAsset, asset, indexer.chainID)
        let assetChain = paraTool.makeAssetChain(asset, indexer.chainID);
        let cachedAssetInfo = indexer.assetInfo[assetChain]
        //console.log(`getAssetInfo cachedAssetInfo`, cachedAssetInfo)
        if (cachedAssetInfo !== undefined && cachedAssetInfo.assetName != undefined && cachedAssetInfo.decimals != undefined && cachedAssetInfo.assetType != undefined && cachedAssetInfo.symbol != undefined) {
            return (cachedAssetInfo);
        }

        if (this.debugLevel >= paraTool.debugVerbose) console.log("parallel assetInfo: NOT FOUND", assetChain);

        try {
            let name = false;
            let symbol = false;
            let decimals = false;
            let assetType = false;
            const convert = (from, to) => str => Buffer.from(str, from).toString(to)
            const hexToUtf8 = convert('hex', 'utf8')

            if (asset.substring(0, 2) == "0x") return (false);
            if (parsedAsset.Token) {
                let id = this.tokenID_to_string(parsedAsset.Token); // QUESTION: how do we avoid "200,070,014"
                let md = await indexer.api.query.assets.metadata(id)
                let assetMetadata = md.toHuman();
                name = assetMetadata.name;
                symbol = assetMetadata.symbol;
                decimals = assetMetadata.decimals;
                assetType = paraTool.assetTypeToken;
            }
            if (decimals && assetType) {
                let assetInfo = {
                    name,
                    symbol,
                    decimals,
                    assetType
                };
                if (this.debugLevel >= paraTool.debugInfo) console.log(`addAssetInfo`, assetInfo)
                await indexer.addAssetInfo(asset, indexer.chainID, assetInfo, 'getAssetInfo');
                return (assetInfo);
            } else {
                if (this.debugLevel >= paraTool.debugErrorOnly) console.log("COULD NOT ADD asset -- no assetType", decimals, assetType, parsedAsset, asset);
            }
        } catch (err) {
            console.log(err);
            this.parserErrors++;
        }
        return (false);
    }

    // decoratedKey: ["hJHcCwqz1xU6NhyEvPEPxvCL8uzvKfo9i8bkzZ9KNQKEijrAe","102"]
    // address seems like the validator's address?
    getOracleRawValuesKey(indexer, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        //console.log(`getOracleRawValuesKey`, k)
        var out = {};
        // oracle is in k[0]
        let assetID = this.cleanedAssetID(k[1]); //currencyID
        this.setAssetSymbolAndDecimals(indexer, assetID, out)
        return out
    }

    getOracleValuesKey(indexer, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        //console.log(`getOracleValuesKey`, k)
        var out = {};
        // oracle is in k[0]
        let assetID = this.cleanedAssetID(k[0]); //currencyID
        this.setAssetSymbolAndDecimals(indexer, assetID, out)
        return out
    }

    /*
    //{"value":"0x000000000000000000899742ab13db2a","timestamp":1653303666594}
    */
    getOracleValuesVal(indexer, decoratedVal) {
        let k = JSON.parse(decoratedVal)
        let res = {}
        let extraField = []
        extraField['timestamp'] = Math.floor(k.timestamp / 1000)
        extraField['rawPrice'] = paraTool.dechexToInt(k.value)
        res["pv"] = ''
        res["extra"] = extraField
        return res
    }

    getLoanBorrowedIndexVal(indexer, decoratedVal) {
        let k = JSON.parse(decoratedVal)
        let res = {}
        let extraField = []
        extraField['borrowIndex'] = paraTool.dechexToInt(decoratedVal)
        res["pv"] = ''
        res["extra"] = extraField
        return res
    }

    getExchangeRateVal(indexer, decoratedVal) {
        let k = JSON.parse(decoratedVal)
        let res = {}
        let extraField = []
        extraField['exchangeRate'] = paraTool.dechexToInt(decoratedVal)
        res["pv"] = ''
        res["extra"] = extraField
        return res
    }
    //'{"voucherBalance":"0x0000000000000000001490f1d3d9d680","isCollateral":false}'
    getLoanDepositeVal(indexer, decoratedVal) {
        let k = JSON.parse(decoratedVal)
        let res = {}
        let extraField = []
        extraField['voucherBalance'] = paraTool.dechexToInt(k.voucherBalance)
        extraField['isCollateral'] = (k.isCollateral) ? 1 : 0
        res["pv"] = ''
        res["extra"] = extraField
        return res
    }


    // reversed: decorate key using val here
    /*
    {
      baseAmount: 795374525627276,
      quoteAmount: 758856193623574,
      baseAmountLast: 0,
      quoteAmountLast: 0,
      lpTokenId: 6003,
      blockTimestampLast: 1030330,
      price0CumulativeLast: '0x000000000000d966d437a1523117798d',
      price1CumulativeLast: '0x000000000000dafea9cc8aca1916b7a7'
    }
    */
    getAmmPoolsVal(indexer, decoratedVal) {
        let k = JSON.parse(decoratedVal)
        let poolInfo = {}
        let res = {}
        let extraField = []
        let tokenInfo = {}
        //let lpTokenID = paraTool.dechexToInt(k.lpTokenId)
        for (const item of Object.keys(k)) {
            let v = paraTool.dechexToInt(k[item])
            poolInfo[item] = v
            extraField[item] = v
        }
        console.log(`getAmmPoolsVal pool info`, poolInfo)
        this.setAssetSymbolAndDecimals(indexer, `${poolInfo.lpTokenId}`, tokenInfo)
        extraField['asset'] = tokenInfo.asset
        extraField['decoratedAsset'] = tokenInfo.decoratedAsset
        extraField['decimals'] = tokenInfo.decimals
        res["pv"] = ''
        res["extra"] = extraField
        console.log(`getAmmPoolsVal`, extraField)
        console.log(`getAmmPoolsVal`, res)
        return res
    }

    //{ principal: '203021433150092', borrowIndex: '1001598143276266837' }
    // we will only keep adjustedPrincipal such that we can get true borrowed balance by computing adjustedPrincipal*borrowIndex at a block
    getLoanBorrowedVal(indexer, decoratedVal) {
        let k = JSON.parse(decoratedVal)
        let res = {}
        let extraField = []
        let principal = paraTool.dechexToInt(k.principal)
        if (principal > 0) {
            let normalizedBorrowIndex = paraTool.dechexToInt(k.borrowIndex) / 10 ** 18
            let adjustedPrincipal = principal / normalizedBorrowIndex
            extraField['principal'] = paraTool.dechexToInt(k.principal)
            extraField['adjustedPrincipal'] = adjustedPrincipal
            extraField['normalizedBorrowIndex'] = normalizedBorrowIndex
        } else {
            // when priciple is fully paid, borrowIndex is zero, hence adjustedPrincipal, normalizedBorrowIndex are also zero
            extraField['principal'] = 0
            extraField['adjustedPrincipal'] = 0
            extraField['normalizedBorrowIndex'] = 0
        }
        res["pv"] = ''
        res["extra"] = extraField
        return res
    }

    // s: "exchangeRate", "totalReserves", "utilizationRatio", "supplyRate", "borrowIndex",  "borrowRate", "totalBorrows", "totalSupply":
    // decoratedKey: ["100"]
    getLoansKey(indexer, s, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        var out = {};
        let assetID = this.cleanedAssetID(k[0]); //currencyID
        this.setAssetSymbolAndDecimals(indexer, assetID, out)
        //Loans:AccountEarned, Loans:AccountDeposits
        // TODO: use s
        return out
    }

    //'["1,001","101"]'
    getAmmPoolsKey(indexer, s, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        let token0 = this.cleanedAssetID(k[0]);
        let token1 = this.cleanedAssetID(k[1]);
        let lp0 = {}
        let lp1 = {}
        this.setAssetSymbolAndDecimals(indexer, token0, lp0)
        this.setAssetSymbolAndDecimals(indexer, token1, lp1)
        var out = {
            lp0: lp0,
            lp1: lp1,
        };
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`getAmmPoolsKey`, out)
        return out
    }

    // s: "accountEarned", "accountDeposits"
    // decoratedKey: ["100","hJKQrtkKZGx3sULzGq3tunYv8ZqLBca3xroJSDteDmiUdp937"]
    getLoansAccountKey(indexer, s, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        var out = {};
        let assetID = this.cleanedAssetID(k[0]); //currencyID
        this.setAssetSymbolAndDecimals(indexer, assetID, out)
        out.accountID = k[1]; //account
        return out
    }


    // decoratedKey: ["hJKH68wLHTsaPqkV2xhVYqPYYRraAghjAjdtQQQGzpo7eMJat"]
    getBalancesLocks(indexer, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        var out = {};
        out.accountID = k[0]; //account
        return out
    }



    getLiquidStakingExchangeRateKey(indexer, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        if (this.debugLevel >= paraTool.debugTracing) console.log(`getLiquidStakingExchangeRateKey`, k)
        var out = {};
        return out
    }


    getLiquidStakingExchangeRateVal(indexer, decoratedVal) {
        let decimals = 18
        let k = JSON.parse(decoratedVal)
        let res = {}
        let extraField = []
        extraField['stakingExchangeRate'] = paraTool.dechexToInt(k) / 10 ** decimals
        res["pv"] = ''
        res["extra"] = extraField
        if (this.debugLevel >= paraTool.debugTracing) console.log(`getLiquidStakingExchangeRateKey`, res)
        return res
    }

    getBalancesTotalIssuance(indexer, decoratedKey) {
        let k = JSON.parse(decoratedKey)
        // TODO:
        var out = {};
        return out
    }

    parseStorageKey(indexer, p, s, key, decoratedKey) {
        let pallet_section = `${p}:${s}`
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel parseStorageKey ps=${pallet_section}`)
        if (pallet_section == "assets:account") {
            // decoratedKey: ["100","hJHfe3mtq3Rx4gcUGtSjXwL4Wmq3Krtt3uumUhXG1rTq9WwZg"]
            return this.getAssetsAccountKey(indexer, decoratedKey);
        } else if (pallet_section == "assets:assets") {
            // decoratedKey: ["100"]
            return this.getAssetsAssetKey(indexer, decoratedKey);
        } else if (pallet_section == "oracle:values") {
            return this.getOracleValuesKey(indexer, decoratedKey);
        } else if (pallet_section == "oracle:rawValues") {
            // decoratedKey: ["hJHcCwqz1xU6NhyEvPEPxvCL8uzvKfo9i8bkzZ9KNQKEijrAe","102"]
            return this.getOracleRawValuesKey(indexer, decoratedKey);
        } else if (pallet_section == "balances:totalIssuance") {
            return this.getBalancesTotalIssuance(indexer, decoratedKey);
        } else if (pallet_section == "balances:locks") {
            // decoratedKey: ["hJKH68wLHTsaPqkV2xhVYqPYYRraAghjAjdtQQQGzpo7eMJat"]
            return this.getBalancesLocks(indexer, decoratedKey);
        } else if (pallet_section == "liquidStaking:exchangeRate") {
            // decoratedKey: ["hJKH68wLHTsaPqkV2xhVYqPYYRraAghjAjdtQQQGzpo7eMJat"]
            return this.getBalancesLocks(indexer, decoratedKey);
        } else if (p == "loans") {
            switch (s) {
                case "rewardBorrowState":
                case "rewardSupplyState":
                case "exchangeRate":
                case "totalReserves":
                case "utilizationRatio":
                case "supplyRate":
                case "borrowIndex":
                case "borrowRate":
                case "totalBorrows":
                case "totalSupply":
                case "lastAccruedInterestTime":
                    return this.getLoansKey(indexer, s, decoratedKey);
                    // ["100"]
                    break;
                    //case "accountEarned":
                case "accountBorrows":
                    // ["100","hJKQrtkKZGx3sULzGq3tunYv8ZqLBca3xroJSDteDmiUdp937"]
                    return this.getLoansAccountKey(indexer, s, decoratedKey);
                case "accountDeposits":
                    // ["100","hJKQrtkKZGx3sULzGq3tunYv8ZqLBca3xroJSDteDmiUdp937"]
                    return this.getLoansAccountKey(indexer, s, decoratedKey);
                case "lastAccruedTimestamp":
                    break;
                default:
                    console.log("[loans] XX", p, s, decoratedKey);
            }
        } else if (pallet_section == "amm:pools") {
            return this.getAmmPoolsKey(indexer, s, decoratedKey);
        } else {
            return super.parseStorageKey(indexer, p, s, key, decoratedKey)
        }
    }

    parseStorageVal(indexer, p, s, val, decoratedVal, o = false) {
        let pallet_section = `${p}:${s}`
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel parseStorageVal ps=${pallet_section}`)
        if (pallet_section == "oracle:values") {
            //skip oracle:rawvalues
            return this.getOracleValuesVal(indexer, decoratedVal);
        } else if (pallet_section == "amm:pools") {
            if (this.debugLevel >= paraTool.debugVerbose) console.log(`[amm] parallel parseStorageVal ps=${pallet_section}`, `decoratedVal=${decoratedVal}`)
            return this.getAmmPoolsVal(indexer, decoratedVal);
        } else if (pallet_section == "liquidStaking:exchangeRate") {
            if (this.debugLevel >= paraTool.debugVerbose) console.log(`[liquidStaking] parallel parseStorageVal ps=${pallet_section}`, `decoratedVal=${decoratedVal}`)
            return this.getLiquidStakingExchangeRateVal(indexer, decoratedVal);
        } else if (p == 'loans') {
            switch (pallet_section) {
                case "loans:exchangeRate":
                    //used to compute supplied blanace
                    return this.getExchangeRateVal(indexer, decoratedVal);
                    break;
                case "loans:borrowIndex":
                    //used to compute borrowed blanace
                    return this.getLoanBorrowedIndexVal(indexer, decoratedVal);
                    break;
                case "loans:accountDeposits":
                    if (this.debugLevel >= paraTool.debugVerbose) console.log(`[Deposit] parallel parseStorageVal ps=${pallet_section}`, `decoratedVal=${decoratedVal}`)
                    return this.getLoanDepositeVal(indexer, decoratedVal);
                    break;
                case "loans:accountBorrows":
                    if (this.debugLevel >= paraTool.debugVerbose) console.log(`[Borrow] parallel parseStorageVal ps=${pallet_section}`, `decoratedVal=${decoratedVal}`)
                    return this.getLoanBorrowedVal(indexer, decoratedVal);
                    break;
                default:
                    if (this.debugLevel >= paraTool.debugVerbose) console.log(`[loans not handled] parallel parseStorageVal ps=${pallet_section}`, `decoratedVal=${decoratedVal}`)
                    break;
            }
        } else {
            return super.parseStorageVal(indexer, p, s, val, decoratedVal, o);
        }
    }

    async processLoansDeposits(indexer, p, s, e2, rAssetkey, fromAddress) {
        e2.voucherBalance = e2.voucherBalance / 10 ** e2.decimals
        //console.log(`processLoansDeposits ${fromAddress}`, e2);
        let assetID = JSON.parse(e2.asset)
        let assetString = this.assetIDWithCommaToAssetString(assetID)
        let suppliedAsset = this.elevatedAssetKey(paraTool.assetTypeCDPSupply, assetString);
        let cdpAsset = this.elevatedAssetKey(paraTool.assetTypeCDP, assetString);
        let assetInfo = indexer.get_asset(cdpAsset)
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`** cdp assetInfo[${cdpAsset}]`, assetInfo)
        let supplyExchangeRate = assetInfo ? assetInfo.supplyExchangeRate : 0
        let aa = {};
        e2.adjustedSupplied = e2.voucherBalance * supplyExchangeRate

        //adjustedSupplied = e2.adjustedPrincadjustedVoucheripal * supplyExchangeRate at time hour
        aa.isCollateral = e2.isCollateral
        aa.adjustedVoucher = e2.voucherBalance
        let assetChain = paraTool.makeAssetChain(suppliedAsset, indexer.chainID);
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`processLoansDeposits ${assetChain} ${fromAddress}`, aa, e2)
        indexer.updateAddressStorage(fromAddress, assetChain, "parallel:processLoansDeposits", aa, this.parserTS, this.parserBlockNumber, paraTool.assetTypeCDPSupply);
    }

    // remove the bogus
    async processLoansBorrows(indexer, p, s, e2, rAssetkey, fromAddress) {
        e2.adjustedPrincipal = e2.adjustedPrincipal / 10 ** e2.decimals
        //console.log(`processLoansBorrows ${fromAddress}`, e2);

        let assetID = JSON.parse(e2.asset)
        let assetString = this.assetIDWithCommaToAssetString(assetID)
        let borrowedAsset = this.elevatedAssetKey(paraTool.assetTypeCDPBorrow, assetString);
        let cdpAsset = this.elevatedAssetKey(paraTool.assetTypeCDP, assetString);
        let assetInfo = indexer.get_asset(cdpAsset)
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`** cdp assetInfo[${cdpAsset}]`, assetInfo)
        let borrowExchangeRate = assetInfo ? assetInfo.borrowExchangeRate : 0
        let aa = {};
        e2.adjustedBorrowed = e2.adjustedPrincipal * borrowExchangeRate

        //adjustedBorrowed = e2.adjustedPrincipal * borrowExchangeRate at time hour
        aa.adjustedPrincipal = e2.adjustedPrincipal

        let assetChain = paraTool.makeAssetChain(borrowedAsset, indexer.chainID);
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`processLoansBorrows ${assetChain} ${fromAddress}`, aa, e2)
        indexer.updateAddressStorage(fromAddress, assetChain, "parallel:processLoansBorrows", aa, this.parserTS, this.parserBlockNumber, paraTool.assetTypeCDPBorrow);
    }


    async processAccountAsset(indexer, p, s, e2, rAssetkey, fromAddress) {
        let pallet_section = `${p}:${s}`
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel processAccountAsset ${pallet_section}`)
        switch (pallet_section) {
            case "Assets:Account":
                await this.processAssetsAccount(indexer, p, s, e2, rAssetkey, fromAddress);
                break;
            case "Loans:AccountDeposits":
                await this.processLoansDeposits(indexer, p, s, e2, rAssetkey, fromAddress);
                break;
            case "Loans:AccountBorrows":
                await this.processLoansBorrows(indexer, p, s, e2, rAssetkey, fromAddress);
                break;
            default:
                super.processAccountAsset(indexer, p, s, e2, rAssetkey, fromAddress);
                break;
        }
        return;
    }

    async processAsset(indexer, p, s, e2) {
        let pallet_section = `${p}:${s}`
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`parallel processAsset ${pallet_section}`)
        switch (pallet_section) {
            case "Assets:Asset":
                await this.processAssetsAsset(indexer, p, s, e2);
                break;
            case "Oracle:RawValues":
                break;
            case "Oracle:Values":
                //console.log(`parallel here ${p}:${s} `, e2)
                await this.processAssetsOracles(indexer, p, s, e2);
                break;
            case "Loans:ExchangeRate":
                await this.processAssetLoanSupplyExchangeRate(indexer, p, s, e2);
                break;
            case "Loans:BorrowIndex":
                await this.processAssetLoanBorrowExchangeRate(indexer, p, s, e2);
                break;
            case "AMM:Pools":
                await this.processAMMPools(indexer, p, s, e2);
                break;
            default:
                super.processAsset(indexer, p, s, e2);
                break;
        }
        return;
    }

    async processAssetsOracles(indexer, p, s, e2) {
        let oracleDecimals = 18
        let price = e2.rawPrice / 10 ** oracleDecimals
        e2.price = price
        let assetID = JSON.parse(e2.asset)
        let parsedAsset = {
            Token: assetID
        }
        if (assetID == '0' || assetID == '1') {
            // manually write native token price
            let nativeAssetString = indexer.getNativeAsset();
            indexer.updateAssetPrice(nativeAssetString, price, paraTool.assetTypeToken, paraTool.assetSourceOracle)
        }
        if (assetID == '100' || assetID == '101') {
            /*
            1000: SKSM = oracle(100)*liquidStaking.exchangeRate
            1001: SDOT = oracle(101)*liquidStaking.exchangeRate
            */
            let liquidStakingAssetStr = this.getLiquidStakingAssetString(indexer)
            let cachedSyntheticRate = indexer.getAssetSyntheticRate(liquidStakingAssetStr, paraTool.assetTypeToken, paraTool.assetSourceOracle)
            if (cachedSyntheticRate != undefined && cachedSyntheticRate > 0) {
                //console.log(`processAssetsOracles syntheticRate already cached. rate=${cachedSyntheticRate}`)
                //only need to update oracle price here
                let syntheticPrice = price * cachedSyntheticRate
                indexer.updateAssetSyntheticRate(liquidStakingAssetStr, syntheticPrice, cachedSyntheticRate, paraTool.assetTypeToken, paraTool.assetSourceOracle)
            } else {
                // api query to retrieve exchange rate
                if (this.debugLevel >= paraTool.debugVerbose) console.log(`processAssetsOracles fetch ${liquidStakingAssetStr} syntheticRate`)
                let syntheticRate = await this.getLiquidStakingExchangeRate(indexer, e2.blockHash)
                let syntheticPrice = price * syntheticRate
                indexer.updateAssetSyntheticRate(liquidStakingAssetStr, syntheticPrice, syntheticRate, paraTool.assetTypeToken, paraTool.assetSourceOracle)
            }
        }
        let assetString = JSON.stringify(parsedAsset);
        //console.log(`processAssetsOracles asset=${assetString}, price=${price}`, e2)
        indexer.updateAssetPrice(assetString, price, paraTool.assetTypeToken, paraTool.assetSourceOracle)
    }

    async getLiquidStakingExchangeRate(indexer, blockHash) {
        let exchangeRate = 0
        try {
            let decimals = 18
            let v = await indexer.api.query.liquidStaking.exchangeRate.at(blockHash);
            exchangeRate = paraTool.dechexToInt(v.toString()) / 10 ** decimals
            if (this.debugLevel >= paraTool.debugInfo) console.log(`getLiquidStakingExchangeRate [blk=${blockHash}], rate=${exchangeRate}`)
        } catch (e) {
            if (this.debugLevel >= paraTool.debugInfo) console.log(`getLiquidStakingExchangeRate [blk=${blockHash}] error`, e)
        }
        return exchangeRate
    }

    async addCustomAsset(indexer) {
        if (indexer.chainID == paraTool.chainIDParallel) {
            let assetID1 = "1"
            let paraAssetToken1 = {
                Token: assetID1
            }
            var paraAssetToken1Str = JSON.stringify(paraAssetToken1);
            let paraToken1Info = {
                name: 'PARA',
                symbol: 'PARA',
                decimals: 12,
                assetType: paraTool.assetTypeToken,
                currencyID: assetID1
            };
            if (this.debugLevel >= paraTool.debugInfo) console.log(`manual addAssetInfo [${paraAssetToken1Str}]`, paraToken1Info)
            await indexer.addAssetInfo(paraAssetToken1Str, paraTool.chainIDParallel, paraToken1Info, 'addCustomAsset');
        } else if (indexer.chainID == paraTool.chainIDHeiko) {
            let assetID0 = "0"
            let heikoAssetToken0 = {
                Token: assetID0
            }
            var heikoAssetToken0Str = JSON.stringify(heikoAssetToken0);
            let heikoToken0Info = {
                name: 'HKO',
                symbol: 'HKO',
                decimals: 12,
                assetType: paraTool.assetTypeToken,
                currencyID: assetID0,
            };
            if (this.debugLevel >= paraTool.debugInfo) console.log(`manual addAssetInfo [${heikoAssetToken0Str}]`, heikoToken0Info)
            await indexer.addAssetInfo(heikoAssetToken0Str, paraTool.chainIDHeiko, heikoToken0Info, 'addCustomAsset');
        }
    }

    async processAMMPools(indexer, p, s, e2) {
        if (this.debugLevel >= paraTool.debugInfo) console.log(`TODO: processAMMPools`, e2)
    }

    async processAssetLoanSupplyExchangeRate(indexer, p, s, e2) {
        //let exchangeRate = e2.exchangeRate / 10 ** e2.decimals
        let exchangeRate = e2.exchangeRate / 10 ** 18
        e2.supplyExchangeRate = exchangeRate
        let assetID = JSON.parse(e2.asset)
        let parsedAsset = {
            Token: assetID
        }
        let assetString = JSON.stringify(parsedAsset);
        let assetInfo = this.getSynchronizedAssetInfo(indexer, parsedAsset)
        let suppliedAssetString = this.elevatedAssetKey(paraTool.assetTypeCDPSupply, assetString);
        let suppliedAsset = JSON.parse(suppliedAssetString)
        let suppliedAssetInfo = this.getSynchronizedAssetInfo(indexer, suppliedAsset)
        let cdpAssetString = this.elevatedAssetKey(paraTool.assetTypeCDP, assetString);
        indexer.updateAssetLoanExchangeRate(cdpAssetString, exchangeRate, "supply");
        //todo: check assetInfo. if not found, add key
        if (suppliedAssetInfo == undefined) {
            //add here
            let cdpSuppliedAssetInfo = {
                assetType: paraTool.assetTypeCDPSupply,
                name: `CDP_Supply:${assetInfo.symbol}`,
                symbol: `CDP_Supply:${assetInfo.symbol}`,
                decimals: assetInfo.decimals,
                isNativeChain: 0
            };
            await indexer.addAssetInfo(suppliedAssetString, indexer.chainID, cdpSuppliedAssetInfo, 'processAssetLoanSupplyExchangeRate');
        }
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`processAssetLoanSupplyExchangeRate (supplied)`, cdpAssetString, e2)
    }

    async processAssetLoanBorrowExchangeRate(indexer, p, s, e2) {
        //let exchangeRate = e2.borrowIndex / 10 ** e2.decimals
        let exchangeRate = e2.borrowIndex / 10 ** 18
        e2.borrowExchangeRate = exchangeRate
        let assetID = JSON.parse(e2.asset)
        let parsedAsset = {
            Token: assetID
        }
        let assetString = JSON.stringify(parsedAsset);
        let assetInfo = this.getSynchronizedAssetInfo(indexer, parsedAsset)
        let borrowedAssetString = this.elevatedAssetKey(paraTool.assetTypeCDPBorrow, assetString);
        let borrowedAsset = JSON.parse(borrowedAssetString)
        let borrowedAssetInfo = this.getSynchronizedAssetInfo(indexer, borrowedAsset)
        let cdpAssetString = this.elevatedAssetKey(paraTool.assetTypeCDP, assetString);
        indexer.updateAssetLoanExchangeRate(cdpAssetString, exchangeRate, "borrow");
        //todo: check assetInfo. if not found, add key
        if (borrowedAssetInfo == undefined) {
            //add here
            let cdpBorrowedAssetInfo = {
                assetType: paraTool.assetTypeCDPBorrow,
                name: `CDP_Borrow:${assetInfo.symbol}`,
                symbol: `CDP_Borrow:${assetInfo.symbol}`,
                decimals: assetInfo.decimals,
                isNativeChain: 0
            };
            await indexer.addAssetInfo(borrowedAssetString, indexer.chainID, cdpBorrowedAssetInfo, 'processAssetLoanBorrowExchangeRate');
        }
        if (this.debugLevel >= paraTool.debugVerbose) console.log(`processAssetLoanBorrowExchangeRate (borrowed)`, cdpAssetString, e2)
    }

    assetIDWithCommaToAsset(assetID) {
        let parsedAsset = {
            Token: assetID
        }
        return parsedAsset
    }

    assetIDWithCommaToAssetDecimal(indexer, assetID) {
        let parsedAsset = {
            Token: assetID
        }
        let cachedAssetInfo = this.getSynchronizedAssetInfo(indexer, parsedAsset)
        if (cachedAssetInfo != undefined && cachedAssetInfo.decimals != undefined) {
            return cachedAssetInfo.decimals
        } else {
            return 12
        }
    }

    assetIDWithCommaToSymbol(indexer, assetID) {
        let parsedAsset = {
            Token: assetID
        }
        let cachedAssetInfo = this.getSynchronizedAssetInfo(indexer, parsedAsset)
        if (cachedAssetInfo != undefined) {
            return {
                Token: cachedAssetInfo.symbol
            }
        } else {
            return {
                Token: `unknown-${assetID}`
            }
        }
    }

    assetIDWithCommaToAssetString(assetID) {
        let parsedAsset = {
            Token: assetID
        }
        let assetString = JSON.stringify(parsedAsset);
        return assetString
    }

    getLiquidStakingAssetString(indexer) {
        let liquidStakingAsset = {}
        if (indexer.chainID == paraTool.chainIDHeiko) {
            liquidStakingAsset.Token = '1000'
        } else if (indexer.chainID == paraTool.chainIDParallel) {
            liquidStakingAsset.Token = '1001'
        }
        return JSON.stringify(liquidStakingAsset)
    }


    //processDecHexCurrencyID(indexer, currency_id)
    async decorate_query_params(query, pallet_method, args, chainID, ts) {
        for (const k of Object.keys(args)) {
            if (k == "asset_id") {
                let symbol = query.getCurrencyIDSymbol(args[k], chainID);
                if (symbol) {
                    args[k + "_symbol"] = symbol
                }
            } else if (k == "route") {
                if (Array.isArray(args[k])) {
                    let symbols = args[k].map((asset_id) => {
                        return query.getCurrencyIDSymbol(asset_id, chainID);
                    })
                    args[k + "_symbols"] = JSON.stringify(symbols)
                }
            } else if (k == "mint_amount" || k == "borrow_amount" || k == "amount_in" || k == "min_amount_out" || k == "repay_amount") { // TODO: check for others?
                if (args.asset_id != undefined) {
                    //TODO: await this.decorateArgsAsset(args, k, args.asset_id, chainID, ts)
                    let currencyDecimals = query.getCurrencyIDDecimal(args.asset_id, chainID);
                    if (currencyDecimals) {
                        args[k + "_value"] = uiTool.presentAmount(args[k], currencyDecimals);
                    }
                } else if (args.route != undefined && Array.isArray(args.route)) {
                    //TODO: await this.decorateArgsAsset(args, k, args.asset_id, chainID, ts)
                    let currencyDecimals = query.getCurrencyIDDecimal(args.route[0], chainID);
                    if (currencyDecimals) {
                        args[k + "_value"] = uiTool.presentAmount(args[k], currencyDecimals);
                    }
                }
            }

        }
        await super.decorate_query_params(query, pallet_method, args, chainID, ts)
    }

}