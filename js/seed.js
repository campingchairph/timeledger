// First-run seed. These are ordinary, editable records (not demo data) — the
// onboarding sheet asks the user to confirm or edit them. This file is the ONLY
// place employer-specific values may appear in the codebase.

export function seedRecords(uid, now) {
  const employerId = uid(), contractId = uid();
  const stamp = { created_at: now, updated_at: now };
  return {
    profile: [{
      id: 'me', full_name: 'Joseph Albino', display_name: 'Joseph Albino', address: '', email: '', phone: '',
      tax_id: '', home_currency: 'PHP', home_timezone: 'Asia/Manila', daily_availability_limit_minutes: 360,
      logo: '', ...stamp,
    }],
    employers: [{
      id: employerId, legal_name: 'Emperor Design Consultants Limited', display_name: 'Emperor', address: '',
      registration_number: '', tax_number: '', primary_contact_name: 'Kellie Evans', primary_contact_role: '',
      primary_contact_email: '', billing_contact_name: '', billing_contact_email: '', logo: '',
      default_currency: 'GBP', default_timezone: 'Europe/London', invoice_prefix: 'EMP-', invoice_next_seq: 1,
      accent: '#1f4e79', notes: '', status: 'active', ...stamp,
    }],
    contracts: [{
      id: contractId, employer_id: employerId, title: 'Freelance design support', start_date: '2026-11-09',
      end_date: '2027-05-31', currency: 'GBP', primary_timezone: 'Asia/Manila', secondary_timezone: 'Europe/London',
      approval_contact_name: 'Kellie Evans', approval_contact_email: '',
      work_arrangement: 'Pay as you play; hours may vary. Hours to be agreed and approved in advance.',
      invoice_requirements: 'Detailed timesheets',
      payment_terms_text: 'Whenever possible within 14 working days of receipt', payment_terms_working_days: 14,
      end_behavior_text: 'Automatically ends 31 May 2027 unless ended earlier under the agreement',
      daily_availability_limit_minutes: null, reporting_anchor_date: '2026-11-09', status: 'active', ...stamp,
    }],
    rates: [{
      id: uid(), contract_id: contractId, hourly_rate: '25.00', currency: 'GBP', effective_from: '2026-11-09',
      effective_to: null, notes: 'Initial contract rate', ...stamp,
    }],
  };
}
