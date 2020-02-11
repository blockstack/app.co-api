const express = require('express');
const { verifyAuthResponse } = require('blockstack/lib/auth/authVerification');
const { decodeToken } = require('jsontokens');
const jwt = require('express-jwt');
const _ = require('lodash');
const { subscribe } = require('mailigen');

const { App, User } = require('../db/models');
const { createToken } = require('../common/lib/auth/token');
const { sendMail, newAppEmail } = require('../common/lib/mailer');
const GSheets = require('../common/lib/gsheets');
const registerViralLoops = require('../common/lib/viral-loops');

const router = express.Router();

router.use(jwt({ secret: process.env.JWT_SECRET, credentialsRequired: false }));

const prod = process.env.NODE_ENV === 'production';

const createableKeys = [
  'name',
  'contact',
  'website',
  'description',
  'imageUrl',
  'category',
  'blockchain',
  'authentication',
  'storageNetwork',
  'openSourceUrl',
  'twitterHandle',
  'contactEmail',
  'submitterName',
  'isSubmittingOwnApp',
  'referralSource',
  'refSource',
  'referralCode',
];

router.post('/submit', async (req, res) => {
  const appData = _.pick(req.body, createableKeys);
  appData.status = 'pending_audit';
  console.log('Request to submit app:', appData);

  if (req.user && req.user.data.username) {
    const { username } = req.user.data;
    console.log('Adding Blockstack ID to app', username);
    appData.adminBlockstackID = username;
  }

  try {
    if (appData.authentication === 'Blockstack' && appData.category !== 'Sample Blockstack Apps') {
      const gsheetsData = {
        ...appData,
        firstName: appData.submitterName,
        appName: appData.name,
        isBlockstackIntegrated: true,
        repo: appData.openSourceUrl,
        appIsPublic: true,
        email: appData.contactEmail,
      };
      if (prod) {
        await GSheets.appendAppMiningSubmission(gsheetsData);
        try {
          await subscribe(
            appData.contactEmail,
            { SOURCE: 'app.co submission' },
            {
              id: 'e36d5dc9',
              update_existing: true,
              double_optin: false,
            },
          );
        } catch (error) {
          console.error('Error while subscribing new app submission to mailing list');
          console.error(error);
        }
      }
    } else if (prod) {
      await GSheets.appendAppCoSubmission({
        ...appData,
        isBlockstackIntegrated: false,
        appIsPublic: true,
      });
    }
    const app = await App.create({
      ...appData,
    });
    try {
      await sendMail(newAppEmail(app));
    } catch (error) {
      if (!prod) {
        console.warn('Unable to send email to admins for new app. Is maildev running?');
      } else {
        console.error('Error sending new app email to admins.');
        console.error(error);
      }
    }
    const { refSource, referralCode } = req.body;
    if (referralCode) {
      try {
        await registerViralLoops(app, referralCode, refSource);
      } catch (error) {
        console.error('Error when registering for viral loops:', error);
      }
    }
    res.json({ success: true, app });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false });
  }
});

router.post('/subscribe', async (req, res) => {
  console.log('Subscribing', req.body.email);
  try {
    await subscribe(
      req.body.email,
      { FROM: 'app.co' },
      {
        update_existing: true,
        double_optin: false,
      },
    );
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

router.post('/blockstack-subscribe', async (req, res) => {
  const { email, from, list, ...rest } = req.body;
  console.log('Subscribing', email);
  try {
    if (list === 'e36d5dc9') {
      await GSheets.appendAppMiningSubmission({
        contactEmail: email,
      });
    }
    await subscribe(
      email,
      {
        FROM: from || 'blockstack.org',
        ...rest,
      },
      {
        id: list || process.env.MAILIGEN_BLOCKSTACK_LIST,
        update_existing: true,
        double_optin: false,
      },
    );
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

router.post('/authenticate', async (req, res) => {
  const { authToken } = req.query;
  if (!authToken) {
    return res.status(400).json({ success: false });
  }

  const nameLookupURL = 'https://core.blockstack.org/v1/names/';
  if (!(await verifyAuthResponse(authToken, nameLookupURL))) {
    console.log('Invalid auth response');
    return res.status(400).json({ success: false });
  }

  const { payload } = decodeToken(authToken);
  console.log(payload);

  const userAttrs = {
    blockstackUsername: payload.username,
  };

  const [user] = await User.findOrBuild({ where: userAttrs, defaults: userAttrs });
  userAttrs.blockstackDID = payload.iss;
  await user.update(userAttrs);
  console.log(user.id);
  const token = createToken(user);

  return res.json({ success: true, token, user });
});

router.post('/app-mining-submission', async (req, res) => {
  const submission = req.body;
  await GSheets.appendAppMiningSubmission(submission);
  res.json({ success: true });
});

router.get('/magic-link/:accessToken', async (req, res) => {
  try {
    const { accessToken } = req.params;
    const app = await App.findOne({
      where: { accessToken },
      attributes: {
        exclude: ['status', 'notes'],
      },
    });
    if (!app) {
      return res.status(404).json({ success: false });
    }
    return res.json({ app });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  }
});

router.post('/magic-link/:accessToken', async (req, res) => {
  try {
    const { accessToken } = req.params;
    const app = await App.findOne({
      where: { accessToken },
    });
    if (!app) {
      return res.status(404).json({ success: false });
    }
    if (!req.user) {
      return res.status(400).json({ success: false, message: 'You must be logged in to claim an app.' });
    }
    if (app.adminBlockstackID) {
      return res.status(400).json({ success: false, message: 'This app has already been claimed.' });
    }
    await app.update({
      adminBlockstackID: req.user.data.username,
    });
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  }
});

module.exports = router;
