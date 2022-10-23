const axios = require('axios')
const aws = require('aws-sdk')
const hmacsha1 = require('hmacsha1')
const randomstring = require('randomstring')
const { TwitterSecrets } = require('./secrets')

aws.config.update({ region: 'us-west-2' })

const dynamoDB = new aws.DynamoDB.DocumentClient()

exports.handler = async function (event, context) {
  // get image url and prediction ID from post request
  const body = JSON.parse(event.body)
  const pokemonImageUrl = body.output[0]
  const predictionId = body.id

  console.log(JSON.stringify(body))

  // grab tweetID from database using prediction ID
  const tweet = await getTweetFromDB(predictionId)

  // if tweet has already been processed, return
  if (tweet.Processed == true) return

  const tweetId = tweet.Tweet_Id

  // get refresh token from DB
  const refreshToken = await getRefreshTokenFromDB()

  // get access token from Twitter
  const {
    accessToken,
    refreshToken: newRefreshToken,
  } = await getNewAccessToken(
    refreshToken,
    TwitterSecrets.clientId,
    TwitterSecrets.basicAuthorizationHeader,
  )

  // save new tokens to DB
  await saveRefreshTokenToDB(newRefreshToken)
  await saveAccessTokenToDB(accessToken)

  // upload image to twitter
  const pokemonImage = await getImage(pokemonImageUrl)

  const { media_id_string: mediaIdString } = await uploadImageToTwitter(
    pokemonImage,
  )

  // reply to tweet using tweetID, mediaID, and image URL
  const tweetedImage = await postImageToTwitter(
    mediaIdString,
    tweetId,
    accessToken,
  )

  console.log(JSON.stringify(tweetedImage))

  // mark tweet as processed in the database
  await markTweetAsProcessed(predictionId, tweetId)

  return {
    statusCode: '200',
  }
}

const markTweetAsProcessed = async (predictionId, tweetId) => {
  await dynamoDB
    .put({
      TableName: 'pokemon-predictions',
      Item: {
        Prediction_Id: predictionId,
        Tweet_Id: tweetId,
        Processed: true,
      },
    })
    .promise()
}

const getImage = async (pokemonImageUrl) => {
  const { data } = await axios({
    method: 'get',
    url: pokemonImageUrl,
    responseType: 'arraybuffer',
  })

  const image = Buffer.from(data, 'binary').toString('base64')

  return image
}

const getAuthenticationHeader = (httpMethod, baseUrl, queryParameters = {}) => {
  const oauthConsumerKey = TwitterSecrets.oauthConsumerKey
  const oauthConsumerSecret = TwitterSecrets.oauthConsumerSecret
  const oauthNonce = randomstring.generate()
  const oauthSignatureMethod = 'HMAC-SHA1'
  const oauthTimestamp = Math.floor(Date.now() / 1000)
  const oauthToken = TwitterSecrets.oauthToken
  const oauthTokenSecret = TwitterSecrets.oauthTokenSecret
  const oauthVersion = '1.0'

  const parameters = {
    oauth_consumer_key: oauthConsumerKey,
    oauth_nonce: oauthNonce,
    oauth_signature_method: oauthSignatureMethod,
    oauth_timestamp: oauthTimestamp,
    oauth_token: oauthToken,
    oauth_version: oauthVersion,
    ...queryParameters,
  }

  console.log(parameters)

  // make parameter string
  let parameterString = ''

  let parameterKeys = Object.keys(parameters)
  parameterKeys = parameterKeys.sort()

  for (let i = 0; i < parameterKeys.length; i++) {
    const key = parameterKeys[i]
    const value = parameters[key]
    parameterString = parameterString.concat(encodeURIComponent(key))
    parameterString = parameterString.concat('=')
    parameterString = parameterString.concat(encodeURIComponent(value))
    if (i != parameterKeys.length - 1) {
      parameterString = parameterString.concat('&')
    }
  }

  // make signature base string
  let signatureBaseString = ''

  signatureBaseString = signatureBaseString.concat(httpMethod.toUpperCase())
  signatureBaseString = signatureBaseString.concat('&')
  signatureBaseString = signatureBaseString.concat(encodeURIComponent(baseUrl))
  signatureBaseString = signatureBaseString.concat('&')
  signatureBaseString = signatureBaseString.concat(
    encodeURIComponent(parameterString),
  )

  let signingKey = ''

  signingKey = signingKey.concat(encodeURIComponent(oauthConsumerSecret))
  signingKey = signingKey.concat('&')
  signingKey = signingKey.concat(encodeURIComponent(oauthTokenSecret))

  // calculating signature
  const oauthSignature = hmacsha1(signingKey, signatureBaseString)

  // calculate header
  let header = 'Oauth '

  const headers = {
    oauth_consumer_key: oauthConsumerKey,
    oauth_nonce: oauthNonce,
    oauth_signature: oauthSignature,
    oauth_signature_method: oauthSignatureMethod,
    oauth_timestamp: oauthTimestamp,
    oauth_token: oauthToken,
    oauth_version: oauthVersion,
  }

  const headerKeys = Object.keys(headers)
  for (let i = 0; i < headerKeys.length; i++) {
    const key = headerKeys[i]
    const value = headers[key]
    header = header.concat(encodeURIComponent(key))
    header = header.concat('=')
    header = header.concat('"')
    header = header.concat(encodeURIComponent(value))
    header = header.concat('"')
    if (i != headerKeys.length - 1) {
      header = header.concat(', ')
    }
  }

  return header
}

const uploadImageToTwitter = async (pokemonImage) => {
  const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json'
  const httpMethod = 'post'

  const { data } = await axios({
    method: httpMethod,
    url: uploadUrl,
    data: {
      media_data: pokemonImage,
    },
    params: {
      additional_owners: TwitterSecrets.userId,
    },
    headers: {
      'Content-Type': 'multipart/form-data',
      Authorization: getAuthenticationHeader(httpMethod, uploadUrl, {
        additional_owners: TwitterSecrets.userId,
      }),
    },
  })

  return data
}

const postImageToTwitter = async (mediaId, tweetToReplyTo, accessToken) => {
  const { data } = await axios({
    method: 'post',
    url: 'https://api.twitter.com/2/tweets',
    data: {
      media: { media_ids: [mediaId] },
      reply: { in_reply_to_tweet_id: tweetToReplyTo },
    },
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
  })

  return data
}

const getTweetFromDB = async (predictionId) => {
  const data = await dynamoDB
    .get({
      TableName: 'pokemon-predictions',
      Key: { Prediction_Id: predictionId },
    })
    .promise()

  return data.Item
}

const saveRefreshTokenToDB = async (refreshToken) => {
  await dynamoDB
    .put({
      TableName: 'twitter-tokens',
      Item: {
        Token: 'refresh_token',
        Value: refreshToken,
      },
    })
    .promise()
}

const saveAccessTokenToDB = async (accessToken) => {
  await dynamoDB
    .put({
      TableName: 'twitter-tokens',
      Item: {
        Token: 'access_token',
        Value: accessToken,
      },
    })
    .promise()
}

const getRefreshTokenFromDB = async () => {
  const data = await dynamoDB
    .get({ TableName: 'twitter-tokens', Key: { Token: 'refresh_token' } })
    .promise()

  return data.Item.Value
}

const getNewAccessToken = async (
  refreshToken,
  clientId,
  basicAuthorizationHeader,
) => {
  const { data } = await axios({
    method: 'post',
    url: 'https://api.twitter.com/2/oauth2/token',
    data: {
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: clientId,
    },
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthorizationHeader,
    },
  })

  return { accessToken: data.access_token, refreshToken: data.refresh_token }
}
