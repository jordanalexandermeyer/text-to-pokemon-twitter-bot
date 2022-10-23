const express = require('express')
const axios = require('axios')
const crypto = require('crypto')
const { AuthorizationCode } = require('simple-oauth2')

const app = express()

const clientId = 'bHFwcDRKczB4WGhWeGNNZUY5aGw6MTpjaQ'
const clientSecret = '-RNYe0qzZpa8gSoxrl7tu-RTV5HjoiuRTnG6EDXuZzrDqWggr5'
const redirectUri = 'http://127.0.0.1:3000/oauth/callback'

const config = {
  client: {
    id: clientId,
    secret: clientSecret,
  },
  auth: {
    authorizePath: '/i/oauth2/authorize',
    authorizeHost: 'https://twitter.com',
    tokenHost: 'https://api.twitter.com',
    tokenPath: '/2/oauth2/token',
    revokePath: '/2/oauth2/revoke',
  },
}

function base64URLEncode(str) {
  return str
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest()
}

const verifier = base64URLEncode(crypto.randomBytes(32))
const challenge = base64URLEncode(sha256(verifier))

const password = clientId + ':' + clientSecret
const basicAuth = btoa(password)

const scopes = ['tweet.read', 'users.read', 'tweet.write', 'offline.access']

const client = new AuthorizationCode(config)

app.get('/', async function (req, res) {
  const authorizationUri = client.authorizeURL({
    redirect_uri: redirectUri,
    scope: scopes,
    state: 'state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  res.redirect(authorizationUri)
})

app.get('/oauth/callback', async function (req, res) {
  try {
    const { data } = await axios({
      method: 'post',
      url: config.auth.tokenHost + config.auth.tokenPath,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + basicAuth,
      },
      data: {
        code: req.query.code,
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    })
    console.log(data)

    res.redirect('/')
  } catch (error) {
    console.dir(JSON.stringify(error))
  }
})
;(() => {
  console.log('Running on port 3000!')
  app.listen(3000)
})()
