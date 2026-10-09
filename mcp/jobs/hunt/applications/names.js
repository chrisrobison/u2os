import crypto from 'node:crypto';

// File names for what goes out (resume, cover letter, the two combined), as
// seen by the recruiter in an attachment list or an applicant tracking system.
// The owner's preference is a name that is memorable and makes a hiring
// manager smile. They are chosen deterministically per job (so the email
// attachment and the form upload for one company carry the same name),
// personalised with the company where that reads naturally, always a plain
// ASCII file name, and always honest: a joke about the candidate, never a
// claim. `style: plain` gives the sober names back.

const word = (value, max = 28) => String(value ?? '').normalize('NFKD').replace(/\([^)]*\)/g, ' ').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '');

// {P} = the candidate, {C} = the company. A name without {C} is used when the company is unknown.
const RESUME = [
  'Hire_{P}_Rare_Opportunity',
  'Why_{C}_Should_Hire_{P}',
  '{P}_Your_Next_Great_Hire',
  '{P}_Has_Entered_The_Chat',
  '{C}_Meet_{P}',
  '{P}_Resume_Debugged_And_Shipped',
  'Read_Me_First_{P}_For_{C}',
  '{P}_The_Missing_Piece_For_{C}',
  '{P}_Resume_Now_Compiling_Without_Warnings',
  'Dear_{C}_Please_Hire_{P}',
];
const LETTER = [
  'A_Letter_To_{C}_From_{P}',
  '{P}_Cover_Letter_Plot_Twist_Included',
  '{P}_Writes_To_{C}',
  'Short_Letter_Big_Hopes_{P}',
];
// Combined letter + resume: the same idea with a hint that two documents are inside.
const COMBINED = [
  'Hire_{P}_Rare_Opportunity_Letter_Inside',
  'Why_{C}_Should_Hire_{P}_Letter_Then_Resume',
  '{P}_Two_For_One_Letter_And_Resume',
  '{P}_Has_Entered_The_Chat_Letter_First',
  'Dear_{C}_Letter_And_Resume_From_{P}',
];
const LISTS = { resume: RESUME, cover_letter: LETTER, resume_with_letter: COMBINED };
const PLAIN = { resume: '{P}_Resume', cover_letter: '{P}_Cover_Letter', resume_with_letter: '{P}_Resume_and_Cover_Letter' };

/**
 * @param kind     resume | cover_letter | resume_with_letter
 * @param person   the candidate's name
 * @param company  the company (optional)
 * @param seed     anything stable per job (the job id): the same job always gets the same name
 * @param style    playful (default) or plain
 */
export function attachmentName({ kind, person, company = '', seed = '', style = 'playful' }) {
  const p = word(person, 40) || 'Candidate';
  const c = word(company, 22);
  let template = PLAIN[kind];
  if (!template) throw new Error(`Unknown attachment kind ${kind}`);
  if (style === 'playful') {
    const options = LISTS[kind].filter((entry) => c || !entry.includes('{C}'));
    const pick = crypto.createHash('sha256').update(`${seed}|${company}`).digest().readUInt32BE(0) % options.length;
    template = options[pick];
  }
  return `${template.replaceAll('{P}', p).replaceAll('{C}', c)}.pdf`.slice(-96).replace(/^[_.-]+/, '');
}
