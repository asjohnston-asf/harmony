const { SecureTokenService } = require('../util/sts');
const { sameRegionAccessRole, awsDefaultRegion } = require('../util/env');

// Allow tokens to last up to 8 hours - no reason to make this a configuration yet
const expirationSeconds = 3600 * 8;

/**
 * Makes a call to assume a role that has access to S3 outputs generated by Harmony
 *
 * @param {RequestContext} context The request context
 * @param {String} username The user making the request
 * @returns {Object} credentials to act as that role
 */
async function _assumeS3OutputsRole(context, username) {
  const { id } = context;
  const params = {
    RoleArn: sameRegionAccessRole,
    RoleSessionName: username,
    DurationSeconds: expirationSeconds,
    ExternalId: id,
  };
  const sts = new SecureTokenService();
  const response = await sts.assumeRole(params);
  return response.Credentials;
}

/**
 * Express.js handler that handles the cloud access JSON endpoint (/cloud-access)
 *
 * @param {http.IncomingMessage} req The request sent by the client
 * @param {http.ServerResponse} res The response to send to the client
 * @returns {Promise<void>} Resolves when the request is complete
 */
async function cloudAccessJson(req, res) {
  req.context.logger = req.context.logger.child({ component: 'cloudAccess.cloudAccessJson' });
  req.context.logger.info(`Generating same region access keys for ${req.user}`);
  try {
    const credentials = await _assumeS3OutputsRole(req.context, req.user);
    res.send(credentials);
  } catch (e) {
    req.context.logger.error(e);
    res.status(500);
    res.json({
      code: 'harmony:ServerError',
      description: 'Error: Failed to assume role to generate access keys',
    });
  }
}

const preamble = `#!/bin/sh\n# Source this file to set keys to access Harmony S3 outputs within the ${awsDefaultRegion} region.\n`;
const accessKeyFields = ['AccessKeyId', 'SecretAccessKey', 'SessionToken'];

/**
 * Express.js handler that handles the cloud access shell endpoint (/cloud-access.sh)
 *
 * @param {http.IncomingMessage} req The request sent by the client
 * @param {http.ServerResponse} res The response to send to the client
 * @returns {Promise<void>} Resolves when the request is complete
 */
async function cloudAccessSh(req, res) {
  req.context.logger = req.context.logger.child({ component: 'cloudAccess.cloudAccessSh' });
  req.context.logger.info(`Generating same region access keys for ${req.user}`);
  res.set('Content-Type', 'application/x-sh');
  try {
    const credentials = await _assumeS3OutputsRole(req.context, req.user);
    let response = preamble;
    response += `# Keys will expire on ${credentials.Expiration}\n\n`;
    for (const key of accessKeyFields) {
      response += `export ${key}='${credentials[key]}'\n`;
    }
    res.send(response);
  } catch (e) {
    req.context.logger.error(e);
    res.status(500);
    res.send('>&2 echo "Error: Failed to assume role to generate access keys"');
  }
}

module.exports = { cloudAccessJson, cloudAccessSh };
