import { Sequelize, DataTypes } from 'sequelize';
import crypto from 'crypto';
import sgMail from '@sendgrid/mail';
import dotenv from 'dotenv';


// Load environment variables
dotenv.config();

// Configure SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Initialize Sequelize for RDS connection
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USERNAME, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  dialect: 'postgres',
  logging: false, // Disable SQL query logging
});

// Define the EmailTracking model
const EmailTracking = sequelize.define('EmailTrackings', {
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
  const token = crypto.randomBytes(16).toString('hex'); // Generate a 16-byte secure token
  const expiryTime = new Date(Date.now() + 2 * 60 * 1000); // Set expiry to 2 minutes
  const link = `http://${process.env.DOMAIN_NAME}/verify?email=${encodeURIComponent(email)}&token=${token}`;
  console.log(token);
  
  
  return { token, link, expiryTime };
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
    await sgMail.send(emailContent);
    
  } catch (error) {
    
    throw new Error('Failed to send verification email');
  }
};

// Lambda handler function
export const handler = async (event) => {
  

  try {
    // Validate event structure
    if (!event.Records || !Array.isArray(event.Records) || event.Records.length === 0) {
      throw new Error('Invalid event structure: No Records found');
    }

    // Parse the SNS message
    const snsMessage = JSON.parse(event.Records[0].Sns.Message);
    const { email } = snsMessage;

    if (!email) {
      throw new Error('Invalid SNS message: Missing email field');
    }

    // Generate token and verification link
    const { token, link, expiryTime } = generateVerificationLink(email);

    // Send the verification email
    await sendVerificationEmail(email, link);


    // Sync the database and save email tracking details
    await sequelize.sync(); // Ensure models are synced
    console.log(token);
    await EmailTracking.create({
      email,
      token,
      expiryTime,
    });

    
  } catch (error) {
    
    throw new Error('Verification process failed');
  }
};
