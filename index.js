import { Sequelize, DataTypes } from 'sequelize';
import crypto from 'crypto';
import sgMail from '@sendgrid/mail';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Secrets Manager client
const secretsManager = new AWS.SecretsManager({ region: process.env.REGION });

// Function to retrieve secrets from AWS Secrets Manager
const getSecret = async (secretName) => {
  try {
    const secret = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
    return JSON.parse(secret.SecretString);
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}:`, error);
    throw new Error(`Failed to retrieve secret: ${secretName}`);
  }
};

// Fetch RDS password and SendGrid API key from Secrets Manager
let rdsPassword, sendGridApiKey;

(async () => {
  try {
    // Retrieve RDS password
    const rdsSecret = await getSecret('rds-db-password');
    rdsPassword = rdsSecret.password;

    // Retrieve SendGrid API key
    const sendGridSecret = await getSecret('sendgrid-api-key');
    sendGridApiKey = sendGridSecret.api_key;

    // Configure SendGrid with retrieved API key
    sgMail.setApiKey(sendGridApiKey);
  } catch (error) {
    console.error('Error initializing secrets:', error.message);
  }
})();

// Initialize Sequelize for RDS connection
const sequelize = new Sequelize(process.env.DB_DATABASE, process.env.DB_USERNAME, rdsPassword, {
  host: process.env.DB_HOST,
  dialect: 'postgres',
  logging: (msg) => console.log(`Sequelize: ${msg}`), // Enable detailed SQL query logging
});

// Define the EmailTracking model
const EmailTracking = sequelize.define('EmailTracking', {
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
}, {
  timestamps: false
});

// Function to generate a token and verification link
const generateVerificationLink = (email) => {
  const token = crypto.randomBytes(20).toString('hex'); // Generate a secure token
  const expirationTime = new Date(Date.now() + 2 * 60 * 1000); // Set expiry to 2 minutes
  const link = `http://${process.env.DOMAIN_NAME}/verify?email=${encodeURIComponent(email)}&token=${token}`;
  console.log(`Generated token: ${token}, expiry: ${expirationTime}, for email: ${email}`);
  return { token, link, expirationTime };
};

// Function to send a verification email using SendGrid
const sendVerificationEmail = async (email, link) => {
  const emailContent = {
    to: email,
    from: process.env.SENDGRID_FROM_EMAIL, // Use the verified sender in SendGrid
    subject: 'Verify Your Email',
    html: `
      <p>Thank you for signing up! Please verify your email address by clicking the link below:</p>
      <p><a href="${link}">Verify Email</a></p>
      <p>This link will expire in 2 minutes.</p>
    `,
  };

  try {
    console.log(`Attempting to send email to ${email} with link: ${link}`);
    await sgMail.send(emailContent);
    console.log(`Verification email sent to ${email}`);
  } catch (error) {
    console.error('Error sending email:', error.response ? error.response.body : error.message);
    throw new Error('Failed to send verification email');
  }
};

// Lambda handler function
export const handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  try {
    // Validate event structure
    if (!event.Records || !Array.isArray(event.Records) || event.Records.length === 0) {
      console.error('Invalid event structure: No Records found');
      throw new Error('Invalid event structure: No Records found');
    }

    // Parse the SNS message
    const snsMessage = JSON.parse(event.Records[0].Sns.Message);
    const { email } = snsMessage;

    if (!email) {
      console.error('Invalid SNS message: Missing email field');
      throw new Error('Invalid SNS message: Missing email field');
    }

    console.log(`Received email: ${email} from SNS message`);

    // Generate token and verification link
    const { token, link, expirationTime } = generateVerificationLink(email);

    // Send the verification email
    await sendVerificationEmail(email, link);

    // Sync the database and save email tracking details
    console.log('Syncing database...');
    await sequelize.sync(); // Ensure models are synced
    console.log('Database synced. Saving email tracking details...');
    await EmailTracking.create({
      email,
      token,
      expiryTime: expirationTime,
    });

    console.log(`Verification email sent and logged for ${email}`);
  } catch (error) {
    console.error('Error handling verification process:', error.message);
    console.error(error.stack); // Log stack trace for debugging
    throw new Error('Verification process failed');
  }
};
