/**
 * Rebel Contracting's capabilities write-up.
 *
 * This text is embedded once (via Amazon Bedrock / Titan Text Embeddings V2)
 * and the resulting vector is cached in DynamoDB (see embeddings.ts). Every
 * incoming solicitation is scored by cosine similarity against this profile,
 * so the quality of the relevance scoring is directly tied to how well this
 * text describes Rebel Contracting's actual capabilities, past performance,
 * certifications, and preferred contract types.
 *
 * To update: edit the text below and redeploy. The embedding cache
 * automatically detects the change (it hashes this string) and re-embeds
 * on the next Lambda invocation — no other code changes needed.
 *
 * See README.md, "Updating the company profile" for details.
 */
export const COMPANY_PROFILE_TEXT = `
Rebel Contracting is a veteran-owned small business operating as a
prime contractor based in Colorado. The company specializes in
low-barrier-to-entry project delivery: work that can be executed
directly with a small crew of fewer than 20 people, or managed as a
prime by subcontracting specialty trades as needed. Rebel Contracting
is well suited to bid on and manage contracts even in trades it does
not perform in-house, such as HVAC, electrical, or other specialty
trade work, by engaging qualified subcontractors.

Strong areas of interest include: janitorial and custodial services;
furniture delivery, installation, and setup; and delivery and
installation of equipment or fixtures, such as bulk delivery and
installation of appliances (e.g. microwaves) in institutional or
government facilities. The company is well suited for facilities
services, installation services, logistics and delivery contracts,
and general labor or trade project management where the work can be
completed by a small team or coordinated subcontractor crew.

Rebel Contracting does not pursue and is not a fit for contracts that
consist primarily of bulk manufacturing, raw material supply, or parts
fabrication with no installation or service component. The company is
also not focused on large-scale ground-up construction requiring
large crews or heavy specialty equipment ownership.

Geographic preference is Colorado and the broader Midwest region.
Rebel Contracting will also consider one-off contract opportunities
anywhere in the continental United States.

Rebel Contracting meets the size standard requirements for a small
business and the ownership and control requirements for a
veteran-owned small business. Formal SBA/VA certification (including
SDVOSB/VOSB verification through the VA's CVE program) has not yet
been completed. Once certified, the company will be well positioned
for set-aside solicitations restricted to small businesses,
veteran-owned businesses, or service-disabled veteran-owned
businesses.
`.trim();
