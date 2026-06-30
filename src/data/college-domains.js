/**
 * src/data/college-domains.js
 *
 * Maps known college email domains → canonical institution names.
 * Used by auth.service.detectInstitution() to auto-suggest the institution
 * field during signup.
 *
 * HOW TO EXTEND:
 *   Simply add a new entry: "yourdomain.edu" : "Your College Name"
 *   Keys must be lowercase. Values are the display name shown to the user.
 *
 * The client CONFIRMS or OVERRIDES the suggestion — it is never silently applied.
 */

'use strict';

/** @type {Record<string, string>} */
const COLLEGE_DOMAINS = {
  // ── Karnataka ────────────────────────────────────────────────────
  'rvce.edu.in':          'RV College of Engineering',
  'pes.edu':              'PES University',
  'msrit.edu':            'M.S. Ramaiah Institute of Technology',
  'bmsit.in':             'BMS Institute of Technology and Management',
  'bmsce.ac.in':          'BMS College of Engineering',
  'nie.ac.in':            'The National Institute of Engineering',
  'vtu.ac.in':            'Visvesvaraya Technological University',
  'jssstu.ac.in':         'JSS Science and Technology University',
  'sit.ac.in':            'Siddaganga Institute of Technology',

  // ── Tamil Nadu ───────────────────────────────────────────────────
  'annauniv.edu':         'Anna University',
  'srmist.edu.in':        'SRM Institute of Science and Technology',
  'vit.ac.in':            'VIT University',
  'sastra.edu':           'SASTRA Deemed University',
  'nitt.edu':             'National Institute of Technology Tiruchirappalli',

  // ── Maharashtra ──────────────────────────────────────────────────
  'coep.ac.in':           'College of Engineering Pune',
  'vjti.ac.in':           'Veermata Jijabai Technological Institute',
  'iitb.ac.in':           'IIT Bombay',

  // ── Delhi / NCR ──────────────────────────────────────────────────
  'iitd.ac.in':           'IIT Delhi',
  'dtu.ac.in':            'Delhi Technological University',
  'nsit.net':             'Netaji Subhas University of Technology',

  // ── National Institutes ──────────────────────────────────────────
  'bits-pilani.ac.in':    'BITS Pilani',
  'pilani.bits-pilani.ac.in': 'BITS Pilani (Pilani Campus)',
  'goa.bits-pilani.ac.in':    'BITS Pilani (Goa Campus)',
  'hyderabad.bits-pilani.ac.in': 'BITS Pilani (Hyderabad Campus)',
  'nit.ac.in':            'National Institute of Technology',

  // ── IITs ─────────────────────────────────────────────────────────
  'iitm.ac.in':           'IIT Madras',
  'iitk.ac.in':           'IIT Kanpur',
  'iitkgp.ac.in':         'IIT Kharagpur',
  'iitg.ac.in':           'IIT Guwahati',
  'iith.ac.in':           'IIT Hyderabad',
  'iitbbs.ac.in':         'IIT Bhubaneswar',

  // ── IIITs ────────────────────────────────────────────────────────
  'iiit.ac.in':           'IIIT Hyderabad',
  'iiitb.ac.in':          'IIIT Bangalore',
  'iiitd.ac.in':          'IIIT Delhi',
};

module.exports = COLLEGE_DOMAINS;
