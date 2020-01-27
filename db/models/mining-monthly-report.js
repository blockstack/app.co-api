const _ = require('lodash');
const URL = require('url');
const request = require('request-promise');
const accounting = require('accounting');
const moment = require('moment-timezone');
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const MiningMonthlyReport = sequelize.define(
    'MiningMonthlyReport',
    {
      month: DataTypes.INTEGER,
      year: DataTypes.INTEGER,
      status: DataTypes.STRING,
      purchaseExchangeName: DataTypes.STRING,
      purchasedAt: DataTypes.DATE,
      purchaseConversionRate: DataTypes.FLOAT,
      BTCTransactionId: DataTypes.STRING,
      name: DataTypes.STRING,
      stxPayoutIsIOU: DataTypes.BOOLEAN,
      stxPayoutTotal: DataTypes.INTEGER,
      stxPayoutDecay: DataTypes.FLOAT,
      stxPayoutConversionRate: DataTypes.FLOAT,
      btcPayoutTotal: DataTypes.INTEGER,
      btcPayoutDecay: DataTypes.FLOAT,
      blockExplorerUrl: {
        type: DataTypes.VIRTUAL,
        get() {
          return process.env.BLOCK_EXPLORER_URL;
        },
      },
      monthName: {
        type: DataTypes.VIRTUAL,
        get() {
          return [
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December',
          ][this.month - 1];
        },
      },
      humanReadableDate: {
        type: DataTypes.VIRTUAL,
        get() {
          return `${this.monthName} ${this.year}`;
        },
      },
      totalRewardsUsd: {
        type: DataTypes.VIRTUAL,
        get() {
          const sum = this.btcPayoutTotal + this.stxPayoutTotal;
          return sum;
        },
      },
      formattedTotalRewardsUsd: {
        type: DataTypes.VIRTUAL,
        get() {
          return accounting.formatMoney(this.totalRewardsUsd);
        },
      },
      friendlyPurchasedAt: {
        type: DataTypes.VIRTUAL,
        get() {
          const date = moment(this.purchasedAt).tz('America/New_York');
          return `${date.format('MMMM D, YYYY')} at ${date.format('h:mm a')} EST`;
        },
      },
    },
    {},
  );
  MiningMonthlyReport.associate = function associate(models) {
    const { privateColumns } = models.App;
    const btcIndex = privateColumns.indexOf('BTCAddress');
    privateColumns.splice(btcIndex, 1);
    MiningMonthlyReport.includeOptions = [
      {
        model: models.MiningReviewerReport,
        include: [
          {
            separate: true,
            model: models.MiningReviewerRanking,
            include: [
              {
                model: models.App,
                attributes: {
                  exclude: privateColumns,
                },
                include: [
                  {
                    model: models.Slug,
                    separate: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        model: models.MiningAppPayout,
      },
    ];

    MiningMonthlyReport.MiningReviewerReport = MiningMonthlyReport.hasMany(models.MiningReviewerReport, {
      foreignKey: 'reportId',
      onDelete: 'CASCADE',
    });

    MiningMonthlyReport.MiningAppPayout = MiningMonthlyReport.hasMany(models.MiningAppPayout, {
      foreignKey: 'reportId',
      onDelete: 'CASCADE',
    });

    MiningMonthlyReport.App = models.App;

    MiningMonthlyReport._models = models;
  };

  MiningMonthlyReport.prototype.getCompositeRankings = function getCompositeRankings() {
    const monthlyReport = this;
    return new Promise(async (resolve) => {
      const apps = {};
      const monthBy = monthlyReport.month === 1 ? 13 : monthlyReport.month;
      const yearBy = monthlyReport.month === 1 ? monthlyReport.year - 1 : monthlyReport.year;
      let lastReport = await MiningMonthlyReport.findOne({
        include: MiningMonthlyReport.includeOptions,
        where: {
          month: {
            [Op.lt]: monthBy,
          },
          year: {
            [Op.lte]: yearBy,
          },
        },
        order: [['year', 'desc'], ['month', 'desc']],
      });
      // only use memory function for after december 2018
      if (lastReport && lastReport.month <= 11 && lastReport.year <= 2018) {
        lastReport = null;
      }
      if (lastReport) {
        lastReport.compositeRankings = await lastReport.getCompositeRankings();
      }
      monthlyReport.MiningReviewerReports.forEach((report) => {
        report.MiningReviewerRankings.forEach(({ standardScore, App }) => {
          const app = App.get({ plain: true });
          const [slug] = App.Slugs;
          app.slug = slug ? slug.value : slug;
          app.authentication = App.authentication;
          app.storageNetwork = App.storageNetwork;
          app.blockchain = App.blockchain;
          apps[app.id] = apps[app.id] || app;
          apps[app.id].rankings = apps[app.id].rankings || [];
          apps[app.id].rankings.push(standardScore);
          apps[app.id][`${report.reviewerName} Score`] = standardScore;
        });
      });
      const {
        purchaseConversionRate,
        stxPayoutTotal,
        stxPayoutDecay,
        stxPayoutConversionRate,
        btcPayoutDecay,
        btcPayoutTotal,
      } = monthlyReport;
      const weighted = (score) => {
        const theta = 0.5;
        if (score >= 0) {
          return score ** theta;
        }
        return -((-score) ** theta);
      };
      let sorted = _.sortBy(Object.values(apps), (app) => {
        const { rankings } = app;
        let sum = 0;
        rankings.forEach((ranking) => {
          sum += weighted(ranking);
        });
        const avg = sum / rankings.length;
        const { hostname } = URL.parse(app.website);
        app.domain = hostname;
        app.averageRanking = avg;
        app.memoryRanking = avg;
        if (lastReport) {
          lastReport.compositeRankings.forEach((previousApp) => {
            if (app.id === previousApp.id) {
              app.previousScore = previousApp.memoryRanking;
              if (monthlyReport.year >= 2020 || (monthlyReport.year >= 2019 && monthlyReport.month >= 4)) {
                app.memoryRanking = 0.25 * (app.previousScore || previousApp.averageRaning) + 0.75 * app.averageRanking;
              } else {
                app.memoryRanking =
                  (5 * app.averageRanking + 4 * (app.previousScore || previousApp.averageRanking)) / 9;
              }
            }
          });
        }
        apps[app.id] = app;
        return -app.memoryRanking;
      });
      let remainingBTC = btcPayoutTotal;
      sorted = sorted.map((app) => {
        const btcPayout = remainingBTC * btcPayoutDecay;
        remainingBTC -= btcPayout;
        const btcRewards = Math.max(btcPayout / purchaseConversionRate, 0.000055);
        app.usdRewards = btcPayout;
        app.formattedUsdRewards = accounting.formatMoney(app.usdRewards);
        app.btcRewards = btcRewards;
        app.formattedBtcRewards = accounting.formatMoney(btcRewards);
        app.payout = { BTC: btcRewards };
        return app;
      });
      if (stxPayoutTotal) {
        let remainingSTX = stxPayoutTotal;
        sorted = sorted.map((app) => {
          const stxPayout = remainingSTX * stxPayoutDecay;
          remainingSTX -= stxPayout;
          const stxRewards = stxPayout / stxPayoutConversionRate;
          app.usdRewards += stxPayout;
          app.formattedUsdRewards = accounting.formatMoney(app.usdRewards);
          app.stxRewards = stxRewards;
          app.formattedSTXRewards = accounting.formatNumber(stxRewards);
          return app;
        });
      }
      return resolve(
        sorted.map((app) => ({
          ...app,
          domain: app.domain,
          averageRanking: app.averageRanking,
          rankings: app.rankings,
          previousScore: app.previousScore,
        })),
      );
    });
  };

  MiningMonthlyReport.prototype.savePaymentInfo = async function savePaymentInfo(txId) {
    const tx = await request({
      uri: `${process.env.BLOCK_EXPLORER_API}/${txId}?limit=1000`,
      json: true,
    });

    const savePromises = tx.out.map(
      (output) =>
        new Promise(async (resolve, reject) => {
          try {
            console.log('Finding app with BTC Address', output.addr);
            // const [BTCAddress] = output.addresses;
            const BTCAddress = output.addr;
            const app = await MiningMonthlyReport.App.findOne({
              where: {
                BTCAddress: {
                  [Op.iLike]: BTCAddress,
                },
              },
            });
            if (app) {
              console.log('Making payout for', app.name);
              // console.log(MiningMonthlyReport.MiningAppPayout);
              // return resolve();
              const paymentAttrs = {
                appId: app.id,
                reportId: this.id,
              };
              // console.log(paymentAttrs);
              const [payment] = await MiningMonthlyReport._models.MiningAppPayout.findOrBuild({
                where: paymentAttrs,
                defaults: paymentAttrs,
              });
              await payment.update({
                ...paymentAttrs,
                BTCPaymentValue: output.value,
              });
              console.log(payment.dataValues);
              return resolve(payment);
            }
            console.log('Could not find app with address:', BTCAddress);
            return resolve();
          } catch (error) {
            console.log(error);
            return reject(error);
          }
        }),
    );

    await Promise.all(savePromises);

    // console.log(tx);
  };

  return MiningMonthlyReport;
};
