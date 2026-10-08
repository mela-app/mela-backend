import { renderAccountDeletionPage } from './account-deletion-page.controller';

describe('the account deletion page', () => {
  it('explains deleting in the app, what goes and what stays', () => {
    const html = renderAccountDeletionPage(null);

    expect(html).toContain('<h1>Delete your Mela account</h1>');
    expect(html).toContain('<strong>Delete account</strong>');
    expect(html).toContain('What is deleted');
    expect(html).toContain('What is kept');
    expect(html).not.toContain('mailto:');
  });

  it('offers the support email to people without the app, safely', () => {
    const html = renderAccountDeletionPage('help@mela.example');

    expect(html).toContain('href="mailto:help@mela.example?subject=Delete%20my%20Mela%20account"');
    expect(renderAccountDeletionPage('"><script>')).not.toContain('<script>');
  });
});
