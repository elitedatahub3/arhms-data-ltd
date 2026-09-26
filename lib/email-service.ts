/**
 * Brevo Email Service
 * 
 * This service handles all transactional emails using Brevo (formerly Sendinblue).
 * Premium high-end email templates for ARHMS TECHNOLOGIES.
 */

// @ts-ignore - Brevo SDK doesn't have complete type definitions
import * as SibApiV3Sdk from '@getbrevo/brevo'
import { createClient } from '@supabase/supabase-js'

// Initialize API instance with API key
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi()

// Set API key using the correct method
// @ts-ignore - SDK type definitions are incomplete
apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY || '')

// Sender configuration
const DEFAULT_SENDER = {
    name: process.env.BREVO_SENDER_NAME || 'ARHMS TECHNOLOGIES',
    email: process.env.BREVO_SENDER_EMAIL || 'ARHMSdatalimited@gmail.com'
}

interface SendEmailOptions {
    to: string
    toName?: string
    subject: string
    htmlContent: string
}

interface EmailResult {
    success: boolean
    messageId?: string
    error?: string
}

/**
 * Core function to send transactional email via Brevo
 */
export async function sendEmail(options: SendEmailOptions): Promise<EmailResult> {
    if (!process.env.BREVO_API_KEY) {
        console.warn('BREVO_API_KEY not set. Email not sent.')
        return { success: false, error: 'Email service not configured' }
    }

    try {
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail()

        sendSmtpEmail.sender = DEFAULT_SENDER
        sendSmtpEmail.to = [{ email: options.to, name: options.toName || options.to }]
        sendSmtpEmail.subject = options.subject
        sendSmtpEmail.htmlContent = options.htmlContent

        const data = await apiInstance.sendTransacEmail(sendSmtpEmail)
        const rawMessageId = data.body?.messageId || data.response?.headers?.['x-message-id']
        const messageId = Array.isArray(rawMessageId) ? rawMessageId[0] : rawMessageId
        console.log('Email sent successfully:', messageId)

        return { success: true, messageId }
    } catch (error: any) {
        console.error('Failed to send email:', error.response?.body || error.message)
        return {
            success: false,
            error: error.response?.body?.message || error.message || 'Failed to send email'
        }
    }
}

/**
 * Premium high-end HTML email template
 */
export function generatePremiumTemplate(title: string, content: string, accentColor: string = '#D4AF37'): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>${title}</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            line-height: 1.7;
            color: #1a1a2e;
            background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
            padding: 40px 20px;
            min-height: 100vh;
        }
        
        .email-wrapper {
            max-width: 600px;
            margin: 0 auto;
        }
        
        .email-container {
            background: #ffffff;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.4),
                0 0 0 1px rgba(212, 175, 55, 0.1);
        }
        
        .header {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%);
            padding: 50px 40px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, ${accentColor}, #f5e6a3, ${accentColor});
        }
        
        .header::after {
            content: '';
            position: absolute;
            top: -50%;
            right: -50%;
            width: 100%;
            height: 200%;
            background: radial-gradient(circle, rgba(212, 175, 55, 0.1) 0%, transparent 70%);
            pointer-events: none;
        }
        
        .logo-container {
            position: relative;
            z-index: 1;
        }
        
        .logo-icon {
            width: 70px;
            height: 70px;
            background: linear-gradient(135deg, ${accentColor} 0%, #f5e6a3 50%, ${accentColor} 100%);
            border-radius: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(212, 175, 55, 0.3);
        }
        
        .logo-text {
            font-size: 36px;
            color: #1a1a2e;
            font-weight: 700;
        }
        
        .brand-name {
            font-size: 26px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: 2px;
            text-transform: uppercase;
            margin-bottom: 8px;
        }
        
        .brand-tagline {
            font-size: 13px;
            color: ${accentColor};
            letter-spacing: 4px;
            text-transform: uppercase;
            font-weight: 500;
        }
        
        .content {
            padding: 50px 40px;
        }
        
        .greeting {
            font-size: 28px;
            font-weight: 700;
            color: #1a1a2e;
            margin-bottom: 10px;
        }
        
        .subtitle {
            font-size: 16px;
            color: #64748b;
            margin-bottom: 35px;
            padding-bottom: 25px;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .message-text {
            font-size: 15px;
            color: #475569;
            margin-bottom: 30px;
            line-height: 1.8;
        }
        
        .info-card {
            background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
            border-radius: 16px;
            padding: 30px;
            margin: 30px 0;
            border: 1px solid #e2e8f0;
        }
        
        .info-card-header {
            display: flex;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .info-card-icon {
            width: 44px;
            height: 44px;
            background: linear-gradient(135deg, ${accentColor} 0%, #f5e6a3 100%);
            border-radius: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-right: 15px;
            font-size: 20px;
        }
        
        .info-card-title {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a2e;
        }
        
        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .info-row:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }
        
        .info-label {
            font-size: 14px;
            color: #64748b;
            font-weight: 500;
        }
        
        .info-value {
            font-size: 14px;
            color: #1a1a2e;
            font-weight: 600;
            text-align: right;
        }
        
        .amount-display {
            text-align: center;
            padding: 35px;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border-radius: 20px;
            margin: 30px 0;
        }
        
        .amount-label {
            font-size: 13px;
            color: rgba(255,255,255,0.7);
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-bottom: 10px;
        }
        
        .amount-value {
            font-size: 42px;
            font-weight: 700;
            color: #ffffff;
        }
        
        .amount-currency {
            color: ${accentColor};
        }
        
        .status-badge {
            display: inline-block;
            padding: 8px 20px;
            border-radius: 50px;
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .status-success {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
        }
        
        .status-failed {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: #ffffff;
        }
        
        .status-pending {
            background: linear-gradient(135deg, ${accentColor} 0%, #f5e6a3 100%);
            color: #1a1a2e;
        }
        
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, ${accentColor} 0%, #f5e6a3 50%, ${accentColor} 100%);
            background-size: 200% 200%;
            color: #1a1a2e !important;
            text-decoration: none;
            padding: 16px 40px;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            box-shadow: 0 10px 30px rgba(212, 175, 55, 0.3);
            transition: all 0.3s ease;
        }
        
        .cta-container {
            text-align: center;
            margin: 40px 0;
        }
        
        .divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, #e2e8f0, transparent);
            margin: 40px 0;
        }
        
        .footer {
            background: #f8fafc;
            padding: 35px 40px;
            text-align: center;
            border-top: 1px solid #e2e8f0;
        }
        
        .footer-text {
            font-size: 13px;
            color: #64748b;
            margin-bottom: 15px;
        }
        
        .footer-links {
            margin-bottom: 20px;
        }
        
        .footer-link {
            color: #1a1a2e;
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            margin: 0 15px;
        }
        
        .footer-copyright {
            font-size: 12px;
            color: #94a3b8;
        }
        
        .highlight-box {
            background: linear-gradient(135deg, rgba(212, 175, 55, 0.1) 0%, rgba(245, 230, 163, 0.1) 100%);
            border-left: 4px solid ${accentColor};
            padding: 20px 25px;
            border-radius: 0 12px 12px 0;
            margin: 25px 0;
        }
        
        .highlight-text {
            font-size: 14px;
            color: #1a1a2e;
            font-weight: 500;
        }
        
        @media only screen and (max-width: 600px) {
            body {
                padding: 20px 15px;
            }
            .header {
                padding: 35px 25px;
            }
            .content {
                padding: 35px 25px;
            }
            .footer {
                padding: 25px 20px;
            }
            .greeting {
                font-size: 24px;
            }
            .brand-name {
                font-size: 22px;
            }
            .amount-value {
                font-size: 34px;
            }
        }
    </style>
</head>
<body>
    <div class="email-wrapper">
        <div class="email-container">
            <div class="header">
                <div class="logo-container">
                    <div class="logo-icon">
                        <span class="logo-text">A</span>
                    </div>
                    <div class="brand-name">ARHMS TECHNOLOGIES</div>
                    <div class="brand-tagline">Premium Data Solutions</div>
                </div>
            </div>
            <div class="content">
                ${content}
            </div>
            <div class="footer">
                <div class="footer-links">
                    <a href="${process.env.NEXT_PUBLIC_APP_URL}" class="footer-link">Website</a>
                    <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard" class="footer-link">Dashboard</a>
                    <a href="mailto:ARHMSdatalimited@gmail.com" class="footer-link">Support</a>
                </div>
                <p class="footer-text">
                    Questions? Reply to this email or contact us at<br>
                    <strong>ARHMSdatalimited@gmail.com</strong>
                </p>
                <p class="footer-copyright">
                    © ${new Date().getFullYear()} ARHMS TECHNOLOGIES. All rights reserved.<br>
                    Ghana's Premium Data Reseller Platform
                </p>
            </div>
        </div>
    </div>
</body>
</html>`
}

// ==========================================
// USER EMAIL FUNCTIONS
// ==========================================

/**
 * Send welcome email after user registration
 */
export async function sendWelcomeEmail(
    email: string,
    firstName: string
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Welcome, ${firstName}! 🎉</h1>
        <p class="subtitle">Your premium data journey begins now</p>
        
        <p class="message-text">
            Thank you for joining <strong>ARHMS TECHNOLOGIES</strong> – Ghana's most trusted 
            premium data reseller platform. Your account has been successfully created and 
            you're now part of an exclusive community.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">✨</div>
                <span class="info-card-title">What You Can Do</span>
            </div>
            <div class="info-row">
                <span class="info-label">💰 Fund Wallet</span>
                <span class="info-value">Instant Paystack top-up</span>
            </div>
            <div class="info-row">
                <span class="info-label">📱 Buy Data</span>
                <span class="info-value">MTN, Telecel, AirtelTigo</span>
            </div>
            <div class="info-row">
                <span class="info-label">👥 Manage Customers</span>
                <span class="info-value">Track all your recipients</span>
            </div>
            <div class="info-row">
                <span class="info-label">📊 Real-time Tracking</span>
                <span class="info-value">Monitor every order</span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard" class="cta-button">
                Access Your Dashboard
            </a>
        </div>
        
        <div class="highlight-box">
            <p class="highlight-text">
                💡 <strong>Pro Tip:</strong> Fund your wallet now and start enjoying the best 
                data prices in Ghana. Our rates are unbeatable!
            </p>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Welcome to ARHMS TECHNOLOGIES, ${firstName}! 🎉`,
        htmlContent: generatePremiumTemplate('Welcome', content)
    })
}

/**
 * Send order placed success email to user
 */
export async function sendOrderSuccessEmail(
    email: string,
    firstName: string,
    orderDetails: {
        referenceCode: string
        phoneNumber: string
        network: string
        size: string
        price: number
    }
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Order Placed Successfully! ✅</h1>
        <p class="subtitle">Your data order is being processed</p>
        
        <p class="message-text">
            Hi ${firstName}, your order has been received and is now being processed. 
            The data bundle will be delivered to the recipient shortly.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">📦</div>
                <span class="info-card-title">Order Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${orderDetails.referenceCode}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Recipient</span>
                <span class="info-value">${orderDetails.phoneNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Network</span>
                <span class="info-value">${orderDetails.network}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Package</span>
                <span class="info-value">${orderDetails.size}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Amount Paid</span>
                <span class="info-value" style="color: #10b981; font-size: 16px;">GHS ${orderDetails.price.toFixed(2)}</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-pending">Processing</span>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/my-orders" class="cta-button">
                Track Your Order
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Order Confirmed - ${orderDetails.referenceCode}`,
        htmlContent: generatePremiumTemplate('Order Confirmed', content)
    })
}

/**
 * Send order failed email to user
 */
export async function sendOrderFailedEmail(
    email: string,
    firstName: string,
    orderDetails: {
        referenceCode: string
        phoneNumber: string
        network: string
        size: string
        reason?: string
    }
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Order Failed ❌</h1>
        <p class="subtitle">We couldn't process your order</p>
        
        <p class="message-text">
            Hi ${firstName}, we're sorry but we were unable to complete your data order. 
            Please don't worry – you can file a complaint to request a refund.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">📦</div>
                <span class="info-card-title">Order Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${orderDetails.referenceCode}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Recipient</span>
                <span class="info-value">${orderDetails.phoneNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Network</span>
                <span class="info-value">${orderDetails.network}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Package</span>
                <span class="info-value">${orderDetails.size}</span>
            </div>
            ${orderDetails.reason ? `
            <div class="info-row">
                <span class="info-label">Reason</span>
                <span class="info-value" style="color: #ef4444;">${orderDetails.reason}</span>
            </div>
            ` : ''}
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-failed">Failed</span>
        </div>
        
        <div class="highlight-box">
            <p class="highlight-text">
                ⚠️ <strong>Next Steps:</strong> Visit your orders page and file a complaint 
                to request a refund. Our team will process it within 24 hours.
            </p>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/my-orders" class="cta-button">
                File a Complaint
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Order Failed - ${orderDetails.referenceCode}`,
        htmlContent: generatePremiumTemplate('Order Failed', content, '#ef4444')
    })
}

/**
 * Send wallet top-up success email to user
 */
export async function sendWalletTopupSuccessEmail(
    email: string,
    firstName: string,
    amount: number,
    reference: string,
    newBalance: number
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Wallet Top-up Successful! 💰</h1>
        <p class="subtitle">Your funds have been added</p>
        
        <div class="amount-display">
            <p class="amount-label">Amount Credited</p>
            <p class="amount-value"><span class="amount-currency">GHS</span> ${amount.toFixed(2)}</p>
        </div>
        
        <p class="message-text">
            Hi ${firstName}, your wallet has been successfully credited. You can now 
            use your balance to purchase data bundles for any network.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">🧾</div>
                <span class="info-card-title">Transaction Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${reference}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Payment Method</span>
                <span class="info-value">Paystack</span>
            </div>
            <div class="info-row">
                <span class="info-label">New Balance</span>
                <span class="info-value" style="color: #10b981; font-size: 16px;">GHS ${newBalance.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success">Completed</span>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages" class="cta-button">
                Buy Data Now
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Wallet Credited - GHS ${amount.toFixed(2)} ✅`,
        htmlContent: generatePremiumTemplate('Wallet Credited', content, '#10b981')
    })
}

/**
 * Send wallet top-up failed email to user
 */
export async function sendWalletTopupFailedEmail(
    email: string,
    firstName: string,
    amount: number,
    reference: string,
    reason?: string
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Payment Failed ❌</h1>
        <p class="subtitle">Your wallet top-up was not completed</p>
        
        <div class="amount-display" style="background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%);">
            <p class="amount-label">Attempted Amount</p>
            <p class="amount-value"><span class="amount-currency" style="color: #fca5a5;">GHS</span> ${amount.toFixed(2)}</p>
        </div>
        
        <p class="message-text">
            Hi ${firstName}, unfortunately your wallet top-up could not be completed. 
            If any amount was deducted from your account, it will be automatically 
            reversed within 24-48 hours.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">🧾</div>
                <span class="info-card-title">Transaction Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${reference}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Payment Method</span>
                <span class="info-value">Paystack</span>
            </div>
            ${reason ? `
            <div class="info-row">
                <span class="info-label">Reason</span>
                <span class="info-value" style="color: #ef4444;">${reason}</span>
            </div>
            ` : ''}
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-failed">Failed</span>
        </div>
        
        <div class="highlight-box">
            <p class="highlight-text">
                💡 <strong>What to do:</strong> Please try again with a different payment 
                method or contact your bank if the issue persists.
            </p>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet" class="cta-button">
                Try Again
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Payment Failed - GHS ${amount.toFixed(2)}`,
        htmlContent: generatePremiumTemplate('Payment Failed', content, '#ef4444')
    })
}

/**
 * Send complaint resolved email to user
 */
export async function sendComplaintResolvedEmail(
    email: string,
    firstName: string,
    complaintDetails: {
        orderRef: string
        status: string
        resolutionNotes: string
    }
): Promise<EmailResult> {
    const isResolved = complaintDetails.status === 'resolved'
    const statusColor = isResolved ? '#10b981' : '#ef4444' // Green or Red
    const statusText = isResolved ? 'Resolved' : 'Rejected'
    const statusBadgeClass = isResolved ? 'status-success' : 'status-failed'

    const content = `
        <h1 class="greeting">Complaint Update 🔔</h1>
        <p class="subtitle">There is an update on your complaint</p>
        
        <p class="message-text">
            Hi ${firstName}, your complaint regarding order <strong>${complaintDetails.orderRef}</strong> has been updated.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">📝</div>
                <span class="info-card-title">Complaint Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order Reference</span>
                <span class="info-value">${complaintDetails.orderRef}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value">
                    <span class="status-badge ${statusBadgeClass}" style="padding: 4px 12px; font-size: 11px;">${statusText}</span>
                </span>
            </div>
            <div class="info-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                <span class="info-label">Resolution Notes</span>
                <span class="info-value" style="text-align: left; background: rgba(0,0,0,0.03); padding: 10px; border-radius: 8px; width: 100%; font-weight: 400;">
                    ${complaintDetails.resolutionNotes || 'No additional notes provided.'}
                </span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/complaints" class="cta-button">
                View Complaint
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Complaint Update - ${complaintDetails.orderRef} [${statusText}]`,
        htmlContent: generatePremiumTemplate(`Complaint ${statusText}`, content, statusColor)
    })
}

/**
 * Send new complaint alert to admin
 */
export async function sendAdminNewComplaintAlert(
    complaintDetails: {
        userEmail: string
        userName: string
        orderRef: string
        title: string
        description: string
        priority: string
    }
): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'

    const content = `
        <h1 class="greeting">New Complaint Alert 🚨</h1>
        <p class="subtitle">A user has filed a new complaint</p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">👤</div>
                <span class="info-card-title">User Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Name</span>
                <span class="info-value">${complaintDetails.userName}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Email</span>
                <span class="info-value">${complaintDetails.userEmail}</span>
            </div>
        </div>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">⚠️</div>
                <span class="info-card-title">Complaint Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order Ref</span>
                <span class="info-value">${complaintDetails.orderRef}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Priority</span>
                <span class="info-value" style="color: ${complaintDetails.priority === 'high' ? '#ef4444' : '#f59e0b'}">
                    ${complaintDetails.priority.toUpperCase()}
                </span>
            </div>
            <div class="info-row">
                <span class="info-label">Title</span>
                <span class="info-value">${complaintDetails.title}</span>
            </div>
            <div class="info-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                <span class="info-label">Description</span>
                <span class="info-value" style="text-align: left; background: rgba(0,0,0,0.03); padding: 10px; border-radius: 8px; width: 100%; font-weight: 400;">
                    ${complaintDetails.description}
                </span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/complaints" class="cta-button">
                Process Complaint
            </a>
        </div>
    `

    return sendEmail({
        to: adminEmail,
        toName: 'Admin',
        subject: `[New Complaint] ${complaintDetails.title} - ${complaintDetails.orderRef}`,
        htmlContent: generatePremiumTemplate('New Complaint', content, '#ef4444')
    })
}

/**
 * Send permanent agent upgrade success email
 */
export async function sendPermanentAgentUpgradeSuccessEmail(
    email: string,
    firstName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Permanent Agent Unlocked! 💎</h1>
        <p class="subtitle">Lifetime access to premium data rates</p>
        
        <p class="message-text">
            Hi ${firstName}, congratulations on upgrading to the <strong>Permanent Agent</strong> membership!
        </p>
        
        <div class="highlight-box">
            <p class="highlight-text">
                👑 You now have <strong>unlimited, lifetime access</strong> to ARHMS Data's lowest agent pricing. Your account will never expire, and you will never need to renew your subscription again.
            </p>
        </div>
        
        <p class="message-text">
            Enjoy permanent premium benefits and start maximizing your profits today.
        </p>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success" style="background: linear-gradient(135deg, #4f46e5 0%, #3730a3 100%);">Lifetime Active</span>
        </div>
        
        <div class="cta-container">
            <a href="${siteUrl}/dashboard/data-packages" class="cta-button" style="background: linear-gradient(135deg, #4f46e5 0%, #312e81 100%); color: #ffffff !important;">
                Buy Partner Data
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Welcome to the Lifetime Elite – Permanent Agent Status 👑`,
        htmlContent: generatePremiumTemplate('Permanent Agent', content, '#4f46e5')
    })
}

// ==========================================
// ADMIN EMAIL FUNCTIONS
// ==========================================

/**
 * Send new order alert to admin when fulfillment is skipped or fails
 */
export async function sendAdminNewOrderAlert(
    orderDetails: {
        referenceCode: string
        phoneNumber: string
        network: string
        size: string
        price: number
        customerName: string
        customerEmail: string
        source: 'main_site' | 'shop_storefront'
        shopName?: string
        reason: string
    }
): Promise<EmailResult> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    )
    
    // Fetch all admins and sub-admins
    const { data: admins } = await supabase
        .from('users')
        .select('email')
        .in('role', ['admin', 'sub-admin'])

    const adminEmails = new Set<string>()
    if (process.env.ADMIN_EMAIL) {
        adminEmails.add(process.env.ADMIN_EMAIL)
    }
    
    if (admins) {
        admins.forEach(admin => {
            if (admin.email) adminEmails.add(admin.email)
        })
    }

    if (adminEmails.size === 0) {
        console.warn('No admin emails found to send new order alert.')
        return { success: false, error: 'No admin emails configured' }
    }

    const isFailure = orderDetails.reason.toLowerCase().includes('error') || orderDetails.reason.toLowerCase().includes('fail')
    const subjectPrefix = isFailure ? '[FULFILLMENT FAILED] Action Required' : '[NEW ORDER] Manual Fulfillment Required'
    const subject = `${subjectPrefix} - ${orderDetails.referenceCode} (${orderDetails.network})`
    const headerTitle = isFailure ? 'Fulfillment Failed ❌' : '⚠️ Action Required'

    const content = `
        <h1 class="greeting">${headerTitle}</h1>
        <p class="subtitle">A new order requires manual fulfillment</p>
        
        <div class="highlight-box" style="background: rgba(239, 68, 68, 0.1); border-left-color: #ef4444;">
            <p class="highlight-text">
                <strong>Reason:</strong> ${orderDetails.reason}
            </p>
        </div>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">📦</div>
                <span class="info-card-title">Order Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${orderDetails.referenceCode}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Source</span>
                <span class="info-value">${orderDetails.source === 'shop_storefront' ? `Shop Storefront (${orderDetails.shopName || 'Unknown'})` : 'Main Site'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Customer</span>
                <span class="info-value">${orderDetails.customerName} (${orderDetails.customerEmail})</span>
            </div>
            <div class="info-row">
                <span class="info-label">Recipient</span>
                <span class="info-value">${orderDetails.phoneNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Network</span>
                <span class="info-value">${orderDetails.network}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Package</span>
                <span class="info-value">${orderDetails.size}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Price</span>
                <span class="info-value">GHS ${orderDetails.price.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/fulfillment" class="cta-button" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: #ffffff !important;">
                Go to Fulfillment Center
            </a>
        </div>
    `

    const htmlContent = generatePremiumTemplate(isFailure ? 'Fulfillment Failed' : 'Manual Action Required', content, '#ef4444')

    try {
        const emailPromises = Array.from(adminEmails).map(email => 
            sendEmail({
                to: email,
                toName: 'Admin',
                subject,
                htmlContent
            })
        )
        
        await Promise.allSettled(emailPromises)
        return { success: true }
    } catch (error: any) {
        console.error('Failed to send admin order alerts:', error)
        return { success: false, error: 'Failed to broadcast admin alerts' }
    }
}


/**
 * Send aggregated bulk order fulfillment alert to all admins/sub-admins
 */
export async function sendAdminBulkOrderAlert(
    details: {
        totalOrders: number
        failureCount: number
        failures: Array<{ referenceCode: string; network: string; reason: string; type: 'error' | 'skipped' }>
        customerName: string
        customerEmail: string
    }
): Promise<EmailResult> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    )

    const { data: admins } = await supabase
        .from('users')
        .select('email')
        .in('role', ['admin', 'sub-admin'])

    const adminEmails = new Set<string>()
    if (process.env.ADMIN_EMAIL) adminEmails.add(process.env.ADMIN_EMAIL)
    if (admins) admins.forEach(a => { if (a.email) adminEmails.add(a.email) })

    if (adminEmails.size === 0) {
        console.warn('[BulkAlert] No admin emails found.')
        return { success: false, error: 'No admin emails configured' }
    }

    const hasErrors = details.failures.some(f => f.type === 'error')
    const hasSkips = details.failures.some(f => f.type === 'skipped')
    const subject = hasErrors
        ? `[BULK FULFILLMENT FAILED] ${details.failureCount}/${details.totalOrders} orders need attention`
        : `[BULK ORDER] Manual Fulfillment Required - ${details.failureCount}/${details.totalOrders} orders skipped`

    const failureRows = details.failures.map(f => `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
            <td style="padding: 8px 12px; font-size: 13px; color: #e2e8f0;">${f.referenceCode}</td>
            <td style="padding: 8px 12px; font-size: 13px; color: #e2e8f0;">${f.network}</td>
            <td style="padding: 8px 12px; font-size: 13px; color: ${f.type === 'error' ? '#f87171' : '#fbbf24'};">${f.type === 'error' ? '❌ Failed' : '⏸️ Skipped'}</td>
            <td style="padding: 8px 12px; font-size: 13px; color: #94a3b8;">${f.reason}</td>
        </tr>`).join('')

    const content = `
        <h1 class="greeting">${hasErrors ? '⚠️ Bulk Fulfillment Issues Detected' : '⏸️ Bulk Order — Manual Fulfillment Required'}</h1>
        <p class="subtitle">Some orders in this bulk batch require your attention</p>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">📊</div>
                <span class="info-card-title">Batch Summary</span>
            </div>
            <div class="info-row">
                <span class="info-label">Customer</span>
                <span class="info-value">${details.customerName} (${details.customerEmail})</span>
            </div>
            <div class="info-row">
                <span class="info-label">Total Orders</span>
                <span class="info-value">${details.totalOrders}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Successful Fulfillments</span>
                <span class="info-value" style="color: #4ade80;">${details.totalOrders - details.failureCount}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Require Manual Action</span>
                <span class="info-value" style="color: #f87171;">${details.failureCount}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>

        <div class="info-card" style="margin-top: 20px;">
            <div class="info-card-header">
                <div class="info-card-icon">📋</div>
                <span class="info-card-title">Orders Requiring Attention</span>
            </div>
            <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                <thead>
                    <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
                        <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #64748b; font-weight: 600;">Reference</th>
                        <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #64748b; font-weight: 600;">Network</th>
                        <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #64748b; font-weight: 600;">Status</th>
                        <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #64748b; font-weight: 600;">Reason</th>
                    </tr>
                </thead>
                <tbody>${failureRows}</tbody>
            </table>
        </div>

        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/fulfillment" class="cta-button" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: #ffffff !important;">
                Go to Fulfillment Center
            </a>
        </div>
    `

    const htmlContent = generatePremiumTemplate(
        hasErrors ? 'Bulk Fulfillment Failed' : 'Manual Fulfillment Required',
        content,
        '#ef4444'
    )

    try {
        const emailPromises = Array.from(adminEmails).map(email =>
            sendEmail({ to: email, toName: 'Admin', subject, htmlContent })
        )
        await Promise.allSettled(emailPromises)
        return { success: true }
    } catch (error: any) {
        console.error('[BulkAlert] Failed to send bulk order alerts:', error)
        return { success: false, error: 'Failed to broadcast bulk alerts' }
    }
}


/**
 * Send welcome notification to admin when new user signs up
 */
export async function sendAdminNewUserAlert(
    userDetails: {
        firstName: string
        lastName: string
        email: string
        phoneNumber: string
    }
): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'

    const content = `
        <h1 class="greeting">New User Registration! 👤</h1>
        <p class="subtitle">A new user has joined the platform</p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">✨</div>
                <span class="info-card-title">New User Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Full Name</span>
                <span class="info-value">${userDetails.firstName} ${userDetails.lastName}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Email</span>
                <span class="info-value">${userDetails.email}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Phone Number</span>
                <span class="info-value">${userDetails.phoneNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Joined At</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/users" class="cta-button">
                View in Admin Panel
            </a>
        </div>
    `

    return sendEmail({
        to: adminEmail,
        toName: 'Admin',
        subject: `👤 New User: ${userDetails.firstName} ${userDetails.lastName}`,
        htmlContent: generatePremiumTemplate('New User Alert', content)
    })
}

// ==========================================
// SHOP ALERT EMAIL FUNCTIONS — OWNER
// ==========================================

/**
 * Alert 3 · Pricing Approved — Email to shop owner
 */
export async function sendShopPricingApprovedEmail(
    email: string,
    firstName: string,
    shopName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Pricing Approved! ✅</h1>
        <p class="subtitle">Your shop prices are now live</p>
        <p class="message-text">
            Hi ${firstName}, your submitted prices for <strong>${shopName}</strong> have been reviewed and approved.
            Your new prices are now <strong>live on your shop</strong>. Customers can start ordering immediately.
        </p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-success">Approved</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop" class="cta-button">View My Shop</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `✅ Your Shop Pricing is Approved — ${shopName}`, htmlContent: generatePremiumTemplate('Pricing Approved', content, '#10b981') })
}

/**
 * Alert 4 · Pricing Rejected — Email to shop owner
 */
export async function sendShopPricingRejectedEmail(
    email: string,
    firstName: string,
    shopName: string,
    reason: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Pricing Needs Revision ⚠️</h1>
        <p class="subtitle">Your pricing submission was returned</p>
        <p class="message-text">Hi ${firstName}, your pricing submission for <strong>${shopName}</strong> has been returned for revision.</p>
        <div class="highlight-box"><p class="highlight-text"><strong>Admin note:</strong> ${reason}</p></div>
        <p class="message-text">Please log in, review the feedback, and resubmit your prices.</p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-failed">Rejected</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/pricing" class="cta-button">Revise Pricing</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `⚠️ Shop Pricing Needs Revision — ${shopName}`, htmlContent: generatePremiumTemplate('Pricing Rejected', content, '#ef4444') })
}

/**
 * Alert 5 · Shop Profile Approved — Email to shop owner
 */
export async function sendShopProfileApprovedEmail(
    email: string,
    firstName: string,
    shopName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Your Shop is Approved! 🎉</h1>
        <p class="subtitle">Welcome to the ARHMS Shop Network</p>
        <p class="message-text">Hi ${firstName}, your shop <strong>${shopName}</strong> has been approved. Set your prices to go live!</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">🚀</div><span class="info-card-title">Next Steps</span></div>
            <div class="info-row"><span class="info-label">1. Set Pricing</span><span class="info-value">Go to Shop → Pricing</span></div>
            <div class="info-row"><span class="info-label">2. Submit for Review</span><span class="info-value">Admin approves within 24hrs</span></div>
            <div class="info-row"><span class="info-label">3. Go Live</span><span class="info-value">Share your shop link & start earning</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-success">Approved</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/pricing" class="cta-button">Set Pricing Now</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `🎉 Your Shop "${shopName}" is Approved!`, htmlContent: generatePremiumTemplate('Shop Approved', content, '#10b981') })
}

/**
 * Alert 6 · Shop Profile Rejected — Email to shop owner
 */
export async function sendShopProfileRejectedEmail(
    email: string,
    firstName: string,
    shopName: string,
    reason: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Shop Application — Action Required ❌</h1>
        <p class="subtitle">Your shop application needs attention</p>
        <p class="message-text">Hi ${firstName}, your shop application for <strong>${shopName}</strong> could not be approved at this time.</p>
        <div class="highlight-box"><p class="highlight-text"><strong>Admin note:</strong> ${reason}</p></div>
        <p class="message-text">Please log in, address the feedback, and resubmit your shop profile.</p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-failed">Rejected</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop" class="cta-button">Update My Profile</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `❌ Shop Application – Action Required (${shopName})`, htmlContent: generatePremiumTemplate('Shop Rejected', content, '#ef4444') })
}

/**
 * Alert 7 · Withdrawal Processed (Paid) — Email to shop owner
 */
export async function sendShopWithdrawalProcessedEmail(
    email: string,
    firstName: string,
    shopName: string,
    netAmount: number,
    momoNumber: string,
    network: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Payout Successful! 💰</h1>
        <p class="subtitle">Your funds have been sent</p>
        <div class="amount-display">
            <p class="amount-label">Net Payout Sent</p>
            <p class="amount-value"><span class="amount-currency">GH</span>${netAmount.toFixed(2)}</p>
        </div>
        <p class="message-text">Hi ${firstName}, your net payout from <strong>${shopName}</strong> has been successfully sent to your ${network} number.</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">🧾</div><span class="info-card-title">Payout Details</span></div>
            <div class="info-row"><span class="info-label">Net Amount</span><span class="info-value" style="color: #10b981;">GH${netAmount.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Network</span><span class="info-value">${network}</span></div>
            <div class="info-row"><span class="info-label">MoMo Number</span><span class="info-value">${momoNumber}</span></div>
            <div class="info-row"><span class="info-label">Date</span><span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-success">Completed</span></div>
        <p class="message-text">Thank you for selling with ARHMSGh. Keep growing!</p>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/withdraw" class="cta-button">View Withdrawal History</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `💰 Net Payout of GH${netAmount.toFixed(2)} Sent — ${shopName}`, htmlContent: generatePremiumTemplate('Payout Successful', content, '#10b981') })
}

/**
 * Alert 7b · Withdrawal Rejected — Email to shop owner
 */
export async function sendShopWithdrawalRejectedEmail(
    email: string,
    firstName: string,
    shopName: string,
    amount: number,
    adminNote: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">Withdrawal Request — Action Required ⚠️</h1>
        <p class="subtitle">Your withdrawal request was not approved</p>
        <div class="amount-display" style="background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%);"> 
            <p class="amount-label">Requested Amount</p>
            <p class="amount-value"><span class="amount-currency" style="color: #fca5a5;">GH</span>${amount.toFixed(2)}</p>
        </div>
        <p class="message-text">Hi ${firstName}, your withdrawal request from <strong>${shopName}</strong> was not approved at this time.</p>
        <div class="highlight-box"><p class="highlight-text"><strong>Admin note:</strong> ${adminNote}</p></div>
        <p class="message-text">Please log in to your dashboard, review the reason, update your payment details, and resubmit your request.</p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-failed">Rejected</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/withdraw" class="cta-button">Update &amp; Resubmit</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `⚠️ Withdrawal Request Rejected — ${shopName}`, htmlContent: generatePremiumTemplate('Withdrawal Rejected', content, '#ef4444') })
}

// ==========================================
// ADMIN SHOP ALERT EMAIL FUNCTIONS
// ==========================================

/**
 * Alert 9 · New Pricing Submission — Email to admin only
 */
export async function sendAdminShopPricingSubmissionAlert(details: {
    shopName: string; ownerName: string; ownerEmail: string; shopId: string; date: string
}): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">New Pricing Submission 🔔</h1>
        <p class="subtitle">A shop owner has submitted pricing for review</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">🏷️</div><span class="info-card-title">Submission Details</span></div>
            <div class="info-row"><span class="info-label">Shop</span><span class="info-value">${details.shopName}</span></div>
            <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${details.ownerName}</span></div>
            <div class="info-row"><span class="info-label">Owner Email</span><span class="info-value">${details.ownerEmail}</span></div>
            <div class="info-row"><span class="info-label">Submitted</span><span class="info-value">${details.date}</span></div>
        </div>
        <div class="cta-container"><a href="${siteUrl}/admin/shops/${details.shopId}" class="cta-button">Review Pricing</a></div>
    `
    return sendEmail({ to: adminEmail, toName: 'Admin', subject: `🔔 New Pricing Submission – ${details.shopName}`, htmlContent: generatePremiumTemplate('Pricing Submission', content) })
}

/**
 * Alert 10 · New Shop Registration — Email to admin only
 */
export async function sendAdminNewShopRegistrationAlert(details: {
    shopName: string; ownerName: string; ownerEmail: string; date: string
}): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">New Shop Registration 🏪</h1>
        <p class="subtitle">A new shop is awaiting your approval</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">🏪</div><span class="info-card-title">Shop Details</span></div>
            <div class="info-row"><span class="info-label">Shop Name</span><span class="info-value">${details.shopName}</span></div>
            <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${details.ownerName}</span></div>
            <div class="info-row"><span class="info-label">Owner Email</span><span class="info-value">${details.ownerEmail}</span></div>
            <div class="info-row"><span class="info-label">Submitted</span><span class="info-value">${details.date}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Pending Review</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/shops" class="cta-button">Review Shop</a></div>
    `
    return sendEmail({ to: adminEmail, toName: 'Admin', subject: `🏪 New Shop Registration – ${details.shopName}`, htmlContent: generatePremiumTemplate('New Shop Registration', content) })
}

/**
 * Alert 11 · Withdrawal Request — Email to admin only
 */
export async function sendAdminShopWithdrawalRequestAlert(details: {
    shopName: string
    ownerName: string
    ownerPhone?: string
    amount: number
    momoNumber: string
    accountName: string
    network: string
    balanceSnapshot: number
    date: string
    shopId: string
    isResubmission?: boolean
}): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const badge = details.isResubmission
        ? `<div style="text-align:center;margin:20px 0;"><span style="background:#7c3aed;color:#fff;padding:6px 16px;border-radius:50px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">♻️ Resubmission</span></div>`
        : ''
    const content = `
        <h1 class="greeting">${details.isResubmission ? 'Resubmitted Withdrawal Request ♻️' : 'New Withdrawal Request 💸'}</h1>
        <p class="subtitle">A shop owner has requested a payout</p>
        ${badge}
        <div class="amount-display">
            <p class="amount-label">Requested Amount</p>
            <p class="amount-value"><span class="amount-currency">GH</span>${details.amount.toFixed(2)}</p>
        </div>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">🏪</div><span class="info-card-title">Request Details</span></div>
            <div class="info-row"><span class="info-label">Shop</span><span class="info-value">${details.shopName}</span></div>
            <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${details.ownerName}</span></div>
            ${details.ownerPhone ? `<div class="info-row"><span class="info-label">Owner Phone</span><span class="info-value">${details.ownerPhone}</span></div>` : ''}
            <div class="info-row"><span class="info-label">Gross Amount</span><span class="info-value" style="color: #D4AF37; font-size:16px;">GH${details.amount.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Network</span><span class="info-value">${details.network}</span></div>
            <div class="info-row"><span class="info-label">Account Name</span><span class="info-value">${details.accountName}</span></div>
            <div class="info-row"><span class="info-label">MoMo Number</span><span class="info-value">${details.momoNumber}</span></div>
            <div class="info-row"><span class="info-label">Remaining Balance</span><span class="info-value" style="color:#10b981;">GH${details.balanceSnapshot.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Requested</span><span class="info-value">${details.date}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Action Required</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/shops/withdrawals" class="cta-button">Process Withdrawal</a></div>
    `
    return sendEmail({ to: adminEmail, toName: 'Admin', subject: `${details.isResubmission ? '♻️ Resubmission' : '💸 New Withdrawal'} – GH${details.amount.toFixed(2)} from ${details.shopName}`, htmlContent: generatePremiumTemplate('Withdrawal Request', content) })
}

/**
 * Commission Wallet payout requested — email to admin only.
 *
 * Separate from the shop alert: that one names a shop and links to
 * /admin/shops/withdrawals, which holds a different queue. An admin following it for a
 * commission payout would find nothing to approve.
 */
export async function sendAdminCommissionWithdrawalAlert(details: {
    partnerName: string
    partnerPhone?: string
    amount: number
    netAmount: number
    accountName: string
    accountNumber: string
    network: string
    requestedAt: string
}, toEmail?: string): Promise<EmailResult> {
    const adminEmail = toEmail || process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://arhmsgh.com'
    const content = `
        <h1 class="greeting">Commission Payout Requested 💸</h1>
        <p class="subtitle">An API partner has asked to withdraw their commission earnings</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">💰</div><span class="info-card-title">Request</span></div>
            <div class="info-row"><span class="info-label">Partner</span><span class="info-value">${details.partnerName}</span></div>
            <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${details.partnerPhone || '—'}</span></div>
            <div class="info-row"><span class="info-label">Amount</span><span class="info-value">GHS ${details.amount.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Net payout</span><span class="info-value">GHS ${details.netAmount.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Pay to</span><span class="info-value">${details.accountName} — ${details.network} ${details.accountNumber}</span></div>
            <div class="info-row"><span class="info-label">Requested</span><span class="info-value">${details.requestedAt}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Action Required</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/commission-withdrawals" class="cta-button">Review Payout</a></div>
    `
    return sendEmail({
        to: adminEmail,
        toName: 'Admin',
        subject: `💸 Commission payout requested - GHS ${details.netAmount.toFixed(2)} - ${details.partnerName}`,
        htmlContent: generatePremiumTemplate('Commission Payout Requested', content),
    })
}

/**
 * Alert 12 · New AFA Membership Application — Email to admin only
 */
export async function sendAdminNewAfaApplicationAlert(details: {
    applicantName: string
    phone: string
    region: string
}, toEmail?: string): Promise<EmailResult> {
    const adminEmail = toEmail || process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.ARHMSgh.com'
    const content = `
        <h1 class="greeting">New AFA Membership Application 🔔</h1>
        <p class="subtitle">A new application has been submitted for review</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">📝</div><span class="info-card-title">Applicant Details</span></div>
            <div class="info-row"><span class="info-label">Name</span><span class="info-value">${details.applicantName}</span></div>
            <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${details.phone}</span></div>
            <div class="info-row"><span class="info-label">Region</span><span class="info-value">${details.region}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Action Required</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/afa-management" class="cta-button">Review Application</a></div>
    `
    return sendEmail({ to: adminEmail, toName: 'Admin', subject: '🔔 New AFA Membership Application - ' + details.applicantName, htmlContent: generatePremiumTemplate('New AFA Application', content) })
}

// ==========================================
// AIRTIME EMAIL FUNCTIONS
// ==========================================

/**
 * Send admin alert email when a new airtime order is placed
 */
export async function sendAdminAirtimeOrderEmail(details: {
    referenceCode: string
    userName: string
    userEmail: string
    userRole: string
    beneficiaryPhone: string
    network: string
    airtimeAmount: number | string
    feeRate?: number | string
    feeAmount?: number | string
    totalPaid: number | string
    walletBalanceAfter?: number | string | null
    useExactAmount: boolean
    source?: string
    orderType?: 'airtime' | 'mashup'
    bundlePreference?: 'balanced' | 'data' | 'voice'
}): Promise<EmailResult> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    try {
        // 1. Fetch support email from settings
        const { data: settings } = await supabase
            .from('admin_settings')
            .select('key, value')
            .eq('key', 'support_email')
            .single()

        // 2. Fetch all main admins (excluding sub-admins for this specific high-priority alert as requested)
        const { data: mainAdmins } = await supabase
            .from('users')
            .select('email')
            .eq('role', 'admin')

        // 3. Compile unique list of recipients
        const adminEmails = new Set<string>()
        
        // Add default/support email
        const supportEmail = (settings as any)?.value?.replace(/"/g, '') || process.env.ADMIN_EMAIL || 'ARHMSdatalimited@gmail.com'
        adminEmails.add(supportEmail)

        // Add all fetched main admins
        if (mainAdmins) {
            mainAdmins.forEach(admin => {
                if (admin.email) adminEmails.add(admin.email)
            })
        }

        if (adminEmails.size === 0) {
            console.warn('[Airtime] No admin emails found to send alert.')
            return { success: false, error: 'No recipients found' }
        }

        const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ARHMSgh.com'
        const isMashup = details.orderType === 'mashup'
        const themeColor = isMashup ? '#f59e0b' : '#25D366'
        const headerIcon = isMashup ? '🎯' : '📱'
        const orderLabel = isMashup ? 'Mashup Bundle Order' : 'Airtime Order'

        // Preference label for mashup
        const prefLabelMap: Record<string, string> = {
            balanced: 'Balanced (Data & Voice)',
            data: 'Data Focus 📊',
            voice: 'Voice Focus 🎙️',
        }
        const prefLabel = details.bundlePreference ? prefLabelMap[details.bundlePreference] || 'Balanced (Data & Voice)' : null

        // Helper to parse numbers if string
        const parseNum = (val: any) => typeof val === 'string' ? parseFloat(val) : val;

        const content = `
            <h1 class="greeting">New ${orderLabel} ${headerIcon}</h1>
            <p class="subtitle">A new ${isMashup ? 'MTN Mashup bundle order' : 'airtime order'} requires your attention</p>
            <p class="message-text">
                A new ${isMashup ? 'Mashup bundle' : 'airtime'} order has been placed and is awaiting fulfillment. Please process it as soon as possible.
            </p>

            ${isMashup ? `
            <div class="highlight-box" style="background: rgba(245, 158, 11, 0.12); border-left: 4px solid #f59e0b; padding: 14px 18px; border-radius: 8px; margin: 16px 0;">
                <p class="highlight-text" style="color: #92400e; font-weight: 700; margin: 0;">
                    🎯 <strong>Mashup Bundle:</strong> Open the <strong>My MTN App</strong>, purchase the bundle for ${details.beneficiaryPhone}, then mark this order as Completed in the admin panel.
                </p>
            </div>` : ''}

            <div class="info-card">
                <div class="info-card-header"><div class="info-card-icon">📋</div><span class="info-card-title">Order Details</span></div>
                <div class="info-row"><span class="info-label">Reference</span><span class="info-value">${details.referenceCode}</span></div>
                <div class="info-row"><span class="info-label">Order Type</span><span class="info-value" style="color: ${themeColor}; font-weight: 700;">${isMashup ? '🎯 Mashup Bundle' : '📱 Standard Airtime'}</span></div>
                ${details.source ? `<div class="info-row"><span class="info-label">Source</span><span class="info-value">${details.source}</span></div>` : ''}
                <div class="info-row"><span class="info-label">Customer</span><span class="info-value">${details.userName} (${details.userRole})</span></div>
                <div class="info-row"><span class="info-label">Email</span><span class="info-value">${details.userEmail}</span></div>
                <div class="info-row"><span class="info-label">Beneficiary Phone</span><span class="info-value">${details.beneficiaryPhone}</span></div>
                <div class="info-row"><span class="info-label">Network</span><span class="info-value">${details.network}</span></div>
                ${isMashup && prefLabel ? `<div class="info-row"><span class="info-label">Bundle Preference</span><span class="info-value" style="color: #f59e0b; font-weight: 700;">${prefLabel}</span></div>` : ''}
                <div class="info-row"><span class="info-label">${isMashup ? 'Bundle Value' : 'Airtime to Send'}</span><span class="info-value" style="color: #10b981; font-size: 16px;">GHS ${parseNum(details.airtimeAmount).toFixed(2)}</span></div>
                ${details.feeRate !== undefined ? `<div class="info-row"><span class="info-label">Fee Rate</span><span class="info-value">${details.feeRate}%</span></div>` : ''}
                ${details.feeAmount !== undefined ? `<div class="info-row"><span class="info-label">Fee Charged</span><span class="info-value">GHS ${parseNum(details.feeAmount).toFixed(2)}</span></div>` : ''}
                <div class="info-row"><span class="info-label">Total Paid by User</span><span class="info-value" style="color: #D4AF37; font-size: 16px;">GHS ${parseNum(details.totalPaid).toFixed(2)}</span></div>
                <div class="info-row"><span class="info-label">Mode</span><span class="info-value">${details.useExactAmount ? 'Exact Amount' : 'Standard'}</span></div>
                ${details.walletBalanceAfter !== undefined && details.walletBalanceAfter !== null ? `<div class="info-row"><span class="info-label">Wallet Balance After</span><span class="info-value">GHS ${parseNum(details.walletBalanceAfter).toFixed(2)}</span></div>` : ''}
                <div class="info-row"><span class="info-label">Timestamp</span><span class="info-value">${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Accra' })}</span></div>
            </div>
            <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Action Required</span></div>
            <div class="cta-container"><a href="${siteUrl}/admin/airtime" class="cta-button" style="background: linear-gradient(135deg, ${themeColor} 0%, ${isMashup ? '#d97706' : '#16a34a'} 100%); color: #ffffff !important;">Manage ${isMashup ? 'Mashup' : 'Airtime'} Orders</a></div>
            <div class="highlight-box">
                <p class="highlight-text">⚠️ <strong>Action Required:</strong> ${isMashup ? `Open My MTN App, buy the <strong>${prefLabel || 'Balanced'}</strong> bundle for <strong>${details.beneficiaryPhone}</strong>, then mark the order as Completed.` : `Log in to your admin panel, process the airtime for ${details.beneficiaryPhone} on ${details.network}, then mark the order as Completed.`}</p>
            </div>
        `

        const htmlContent = generatePremiumTemplate(`New ${orderLabel}`, content, themeColor)
        const subject = isMashup
            ? `🎯 [MASHUP] New Bundle Order — ${details.referenceCode} | MTN | GHS ${parseNum(details.airtimeAmount).toFixed(2)}`
            : `📱 ${details.source ? `[${details.source.split(' ')[0]}] ` : ''}New Airtime Order — ${details.referenceCode} | ${details.network} | GHS ${parseNum(details.airtimeAmount).toFixed(2)}`

        // Send to all unique admins
        const emailPromises = Array.from(adminEmails).map(email => 
            sendEmail({ to: email, toName: 'Admin', subject, htmlContent })
        )
        
        await Promise.allSettled(emailPromises)
        return { success: true }
    } catch (error: any) {
        console.error('[Airtime] Failed to send admin order alerts:', error)
        return { success: false, error: 'Failed to broadcast admin alerts' }
    }
}

