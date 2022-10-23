const axios = require('axios')
const aws = require('aws-sdk')
const crypto = require('crypto')
const { TwitterSecrets, ReplicateSecrets } = require('./secrets')

aws.config.update({ region: 'us-west-2' })

const dynamoDB = new aws.DynamoDB.DocumentClient()

exports.handler = async function (event, context) {
  // handle crc check
  const queryParameters = event.queryStringParameters
  const crc_token = queryParameters?.crc_token

  if (crc_token) {
    // return with response token
    const responseToken = getChallengeResponse(
      crc_token,
      TwitterSecrets.oauthConsumerSecret,
    )

    return {
      statusCode: '200',
      body: JSON.stringify({ response_token: 'sha256=' + responseToken }),
    }
  }

  const body = JSON.parse(event.body)

  console.log(JSON.stringify(body))

  // if not a tweet created event, return
  if (!('tweet_create_events' in body)) return
  const tweet = body.tweet_create_events[0]
  const tweetId = tweet.id_str

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

  // get tweet from Twitter
  const tweetFromTwitter = await getTweet(tweetId, accessToken)

  console.log(JSON.stringify(tweetFromTwitter))

  // if tweet doesn't explicitly mention text_to_pokemon return
  const users = tweetFromTwitter?.includes?.users
  if (users) {
    let explicitlyMentioned = false
    for (let i = 0; i < users.length; i++) {
      const user = users[i]
      if (user.id == TwitterSecrets.userId) {
        explicitlyMentioned = true
      }
    }
    if (!explicitlyMentioned) return
  } else return

  const textWithoutMention = removeMentionFromText(tweet.text)

  // start predictive model
  const prediction = await startModel(
    textWithoutMention,
    ReplicateSecrets.modelVersion,
    ReplicateSecrets.webhookUrl,
    ReplicateSecrets.apiToken,
  )

  console.log(JSON.stringify(prediction))

  // save job in DB with prediction ID and tweet ID
  const predictionId = prediction.id

  await savePredictionToDB(predictionId, tweetId)

  return {
    statusCode: '200',
  }
}

const getTweet = async (tweetId, accessToken) => {
  const { data } = await axios({
    method: 'get',
    url: `https://api.twitter.com/2/tweets/${tweetId}`,
    params: {
      expansions: 'entities.mentions.username',
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  return data
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

const getChallengeResponse = (crc_token, consumer_secret) => {
  const hmac = crypto
    .createHmac('sha256', consumer_secret)
    .update(crc_token)
    .digest('base64')

  return hmac
}

const savePredictionToDB = async (predictionId, tweetId) => {
  await dynamoDB
    .put({
      TableName: 'pokemon-predictions',
      Item: {
        Prediction_Id: predictionId,
        Tweet_Id: tweetId,
        Processed: false,
      },
    })
    .promise()
}

const startModel = async (text, version, webhookUrl, apiToken) => {
  const { data } = await axios({
    method: 'post',
    url: 'https://api.replicate.com/v1/predictions',
    data: {
      version: version,
      input: { prompt: text },
      webhook_completed: webhookUrl,
    },
    headers: {
      Authorization: 'Token ' + apiToken,
      'Content-Type': 'application/json',
    },
  })

  return data
}

const removeMentionFromText = (textWithMention) => {
  return textWithMention.replace(/@\S+/gi, '').trim()
}
