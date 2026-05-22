const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    ciphers: 'SSLv3',
  },
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const data = JSON.parse(event.body);
    const { type } = data;

    let toAddress = process.env.SMTP_USER;
    let subject = '';
    let html = '';
    let confirmSubject = '';
    let confirmHtml = '';
    let confirmTo = '';

    // ── CANDIDATE BETA SIGNUP ──
    if (type === 'candidate_signup') {
      const { first, email, linkedin, location } = data;
      subject = `New candidate signup — ${first}`;
      html = `
        <h2>New candidate signup</h2>
        <p><strong>Name:</strong> ${first}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>LinkedIn:</strong> ${linkedin || 'not provided'}</p>
        <p><strong>Location:</strong> ${location || 'not provided'}</p>
      `;
      confirmTo = email;
      confirmSubject = `You're on the list, ${first}`;
      confirmHtml = `
        <p>Hi ${first},</p>
        <p>You're on the vett.work early access list. We'll be in touch as soon as your profile is ready to build.</p>
        <p>In the meantime, if you want a head start — grab your AI video cover letter for $19.99 at vett.work/candidate.</p>
        <p>— The vett.work team</p>
      `;
    }

    // ── JOB APPLICATION ──
    else if (type === 'job_application') {
      const { name, email, role, company, link, note } = data;
      subject = `New application — ${role} at ${company}`;
      html = `
        <h2>New job application</h2>
        <p><strong>Role:</strong> ${role} at ${company}</p>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>LinkedIn / CV link:</strong> ${link || 'not provided'}</p>
        <p><strong>Note:</strong> ${note || 'none'}</p>
      `;
      confirmTo = email;
      confirmSubject = `Application received — ${role} at ${company}`;
      confirmHtml = `
        <p>Hi ${name},</p>
        <p>Your application for <strong>${role}</strong> at <strong>${company}</strong> has been received.</p>
        <p>If you haven't already, consider adding a video cover letter to your application — candidates with video profiles are significantly more likely to get a response. You can create yours at vett.work/candidate for $19.99.</p>
        <p>Good luck!</p>
        <p>— The vett.work team</p>
      `;
    }

    // ── EMPLOYER ENQUIRY ──
    else if (type === 'employer_enquiry') {
      const { name, company, email, role, message, tier } = data;
      subject = `New employer enquiry — ${company || name}`;
      html = `
        <h2>New employer enquiry</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Company:</strong> ${company || 'not provided'}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Role:</strong> ${role || 'not specified'}</p>
        <p><strong>Interested in:</strong> ${tier || 'not specified'}</p>
        <p><strong>Message:</strong> ${message || 'none'}</p>
      `;
      confirmTo = email;
      confirmSubject = `We got your enquiry, ${name}`;
      confirmHtml = `
        <p>Hi ${name},</p>
        <p>Thanks for reaching out. We'll be back to you within one business day to get your role sorted.</p>
        <p>— The vett.work team</p>
      `;
    }

    // ── AGENCY INTEREST ──
    else if (type === 'agency_interest') {
      const { name, company, email, payroll, note } = data;
      subject = `Agency interest — ${company || name}`;
      html = `
        <h2>Agency interest registered</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Agency:</strong> ${company || 'not provided'}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Payroll system:</strong> ${payroll || 'not specified'}</p>
        <p><strong>Note:</strong> ${note || 'none'}</p>
      `;
      confirmTo = email;
      confirmSubject = `You're on the agency list, ${name}`;
      confirmHtml = `
        <p>Hi ${name},</p>
        <p>We have your details. When agency features are ready to launch in 2027, you'll be the first to know.</p>
        <p>— The vett.work team</p>
      `;
    }

    // CONTACT FORM
    else if (type === 'contact') {
      const { name, email, contactType, message } = data;
      subject = `New contact message — ${name}`;
      html = `
        <h2>New contact message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>They are a:</strong> ${contactType || 'not specified'}</p>
        <p><strong>Message:</strong> ${message}</p>
      `;
      confirmTo = email;
      confirmSubject = `We got your message`;
      confirmHtml = `
        <p>Hi ${name.split(' ')[0]},</p>
        <p>Thanks for reaching out. We'll get back to you within one business day.</p>
        <p>— The vett.work team</p>
      `;
    }

    else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type' }) };
    }

    // Send internal notification
    await transporter.sendMail({
      from: `vett.work <${process.env.SMTP_USER}>`,
      to: toAddress,
      subject,
      html,
    });

    // Send confirmation to user
    if (confirmTo) {
      await transporter.sendMail({
        from: `vett.work <${process.env.SMTP_USER}>`,
        to: confirmTo,
        subject: confirmSubject,
        html: confirmHtml,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    };

  } catch (err) {
    console.error('Email error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to send email' }),
    };
  }
};
