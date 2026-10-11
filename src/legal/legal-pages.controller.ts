import { Controller, Get, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { LegalPageContext, renderPrivacyPage, renderTermsPage } from './legal-pages';

/**
 * `/terms` and `/privacy` - the Terms of Service and Privacy Policy, at the
 * root like `/delete-account` (for the store listings, sign-up and settings).
 */
@Controller({ version: VERSION_NEUTRAL })
export class LegalPagesController {
  constructor(private readonly config: ConfigService) {}

  @Get('terms')
  terms(@Res() res: Response): void {
    this.send(res, renderTermsPage(this.context()));
  }

  @Get('privacy')
  privacy(@Res() res: Response): void {
    this.send(res, renderPrivacyPage(this.context()));
  }

  private context(): LegalPageContext {
    return {
      operator: this.config.get<string>('LEGAL_OPERATOR_NAME')?.trim() || 'Mela',
      supportEmail: this.config.get<string>('SUPPORT_EMAIL')?.trim() || null,
    };
  }

  private send(res: Response, html: string): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.send(html);
  }
}
