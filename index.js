import AWS from 'aws-sdk';
import { Sequelize, DataTypes } from 'sequelize';
import crypto from 'crypto';
import dotenv from 'dotenv';
import sgMail from '@sendgrid/mail';

dotenv.config();

// Initialize AWS SDK for Secrets Manager
const secretsManager = new AWS.SecretsManager({ region: process.env.REGION });

// Function to get the SendGrid API Key from Secrets Manager
let sendgridApiKey;
async function getSendgridApiKey() {
  try {
    const data = await secretsManager.getSecretValue({ SecretId: process.env.SENDGRID_SECRET_NAME }).promise();
    sendgridApiKey = JSON.parse(data.SecretString).api_key;
    console.log("SendGrid API Key fetched successfully.");
  } catch (error) {
    console.error("Error fetching SendGrid API key:", error);
    throw error;
  }
  return sendgridApiKey;
}

// Function to get the Database Password from Secrets Manager
let dbPassword;
async function getDbPassword() {
  try {
    const data = await secretsManager.getSecretValue({ SecretId: process.env.RDS_SECRET_NAME }).promise();
    dbPassword = JSON.parse(data.SecretString).password;
    console.log("Database Password fetched successfully.");
  } catch (error) {
    console.error("Error fetching Database password:", error);
    throw error;
  }
  process.env.DB_PASSWORD = dbPassword; // Set as environment variable for later use
  return dbPassword;
}

// Helper function to generate verification link
function generateVerificationLink(email) {
  const token = crypto.randomBytes(20).toString('hex'); // Generate secure token
  const expirationTime = new Date(Date.now() + 2 * 60 * 1000); // Expire in 2 minutes
  const link = `http://${process.env.DOMAIN_NAME}/verify?email=${encodeURIComponent(email)}&token=${token}`;
  console.log(`Generated token: ${token}, expiry: ${expirationTime}, for email: ${email}`);
  return { token, link, expirationTime };
}

// Lambda Handler
export const handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  try {
    const snsMessage = JSON.parse(event.Records[0].Sns.Message);
    const { email } = snsMessage;

    if (!email) {
      console.error("Invalid SNS message: Missing email field");
      throw new Error("Invalid SNS message: Missing email field");
    }

    console.log(`Received email: ${email} from SNS message`);

    // Generate the verification link
    const { token, link, expirationTime } = generateVerificationLink(email);

    // Get SendGrid API Key
    const apiKey = await getSendgridApiKey();

    // Initialize SendGrid with API Key
    sgMail.setApiKey(apiKey);

    // Send Email via SendGrid
    const emailContent = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL, // Verified sender in SendGrid
      subject: 'Verify Your Email',
      text: `Click the following link to verify your email: ${link}. This link will expire in 2 minutes.`,
      html: `<p>Click the following link to verify your email: <a href="${link}">${link}</a>. This link will expire in 2 minutes.</p>`,
    };

    await sgMail.send(emailContent);
    console.log(`Verification email sent to ${email}`);

    // Get Database Password
    await getDbPassword();

    // RDS Connection Setup with retrieved password
    const sequelize = new Sequelize(process.env.DB_DATABASE, process.env.DB_USERNAME, process.env.DB_PASSWORD, {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432, // Default to 5432 if not specified
      dialect: 'postgres',
      logging: (msg) => console.log(`Sequelize: ${msg}`), // Detailed SQL logging
    });

    // Define EmailTracking Model with Your Schema
    const EmailTracking = sequelize.define(
      'EmailTracking',
      {
        email: {
          type: DataTypes.STRING,
          allowNull: false,
          validate: {
            isEmail: true,
          },
        },
        token: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        expiryTime: {
          type: DataTypes.DATE,
          allowNull: false,
        },
      },
      {
        timestamps: false,
      }
    );

    // Insert Record into RDS
    console.log("Syncing database...");
    await sequelize.sync();
    console.log("Database synced. Saving email tracking details...");
    await EmailTracking.create({
      email,
      token,
      expiryTime: expirationTime,
    });

    console.log(`Verification email logged successfully for ${email}`);
  } catch (error) {
    console.error("Error handling the verification process:", error);
    throw new Error("Verification process failed.");
  }
};
