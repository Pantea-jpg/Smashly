import { DEFAULT_LANGUAGE, resources } from '@tw/i18n';
import i18next, { type TFunction } from 'i18next';
import type { EmailJob } from '../../core/outbox/outbox';
import type { EmailMessage } from './mailer';

const i18n = i18next.createInstance();
void i18n.init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  ns: ['emails'],
  defaultNS: 'emails',
  initAsync: false,
  interpolation: { escapeValue: false }, // we escape explicitly for HTML below
});

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface Layout {
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footnotes: string[];
}

function layout(job: EmailJob, t: TFunction<'emails'>): Layout {
  const { template, params } = job;
  switch (template) {
    case 'verifyEmail':
    case 'resetPassword':
      return {
        subject: t(`${template}.subject`),
        paragraphs: [t(`${template}.intro`)],
        action: params.link ? { label: t(`${template}.action`), url: params.link } : undefined,
        footnotes: [t(`${template}.expiry`), t(`${template}.ignore`)],
      } as Layout;
    case 'passwordChanged':
      return {
        subject: t('passwordChanged.subject'),
        paragraphs: [t('passwordChanged.intro')],
        footnotes: [t('passwordChanged.warning')],
      };
    case 'accountApproved':
      return {
        subject: t('accountApproved.subject'),
        paragraphs: [t('accountApproved.intro')],
        footnotes: [],
      };
  }
}

/** Renders a transactional email in the recipient's language (plain text + simple HTML). */
export function renderEmail(job: EmailJob): EmailMessage {
  const t = i18n.getFixedT(job.language, 'emails');
  const greeting = t('greeting', { firstName: job.params.firstName });
  const signature = t('signature');
  const content = layout(job, t);

  const textParts = [greeting, '', ...content.paragraphs, ''];
  if (content.action) textParts.push(`${content.action.label}: ${content.action.url}`, '');
  textParts.push(...content.footnotes, '', signature);

  const button = content.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="background:#0A63D6;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(content.action.label)}</a></p>
<p style="color:#5C5C66;font-size:13px">${escapeHtml(t('linkFallback'))}<br><span style="word-break:break-all">${escapeHtml(content.action.url)}</span></p>`
    : '';

  const html = `<!doctype html>
<html lang="${job.language}"><body style="margin:0;padding:24px;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111114">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px">
<p>${escapeHtml(greeting)}</p>
${content.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${button}
${content.footnotes.map((p) => `<p style="color:#5C5C66;font-size:13px">${escapeHtml(p)}</p>`).join('\n')}
<p>${escapeHtml(signature)}</p>
</div></body></html>`;

  return { to: job.to, subject: content.subject, text: textParts.join('\n'), html };
}
