import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { auth, db, functions, googleProvider, storage } from './firebase'
import './App.css'

const DEFAULT_FORM = {
  company: '',
  role: '',
  stage: 'applied',
  appliedDate: dayjs().format('YYYY-MM-DD'),
  jobUrl: '',
  notes: '',
  resumeText: '',
  resumeFileName: '',
  jdText: '',
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'from',
  'your',
  'you',
  'are',
  'our',
  'this',
  'will',
  'have',
  'has',
  'into',
  'use',
  'using',
  'job',
  'role',
  'work',
  'team',
  'years',
  'year',
  'plus',
  'who',
  'all',
  'any',
  'not',
  'but',
])

const normalizeText = (text) =>
  (text || '').toLowerCase().replace(/[^a-z0-9+\s]/g, ' ')

const extractKeywords = (text) =>
  [...new Set(normalizeText(text).split(/\s+/).filter(Boolean))].filter(
    (word) => word.length > 2 && !STOP_WORDS.has(word),
  )

const buildBulletSuggestions = (matchedSkills, missingSkills, role, company) => {
  const topMatched = matchedSkills.slice(0, 3)
  const topMissing = missingSkills.slice(0, 2)
  const rolePart = role ? `for a ${role} position` : 'for the target role'
  const companyPart = company ? ` at ${company}` : ''
  const skillPhrase = topMatched.length
    ? topMatched.join(', ')
    : 'backend APIs, debugging, and delivery ownership'
  const gapPhrase = topMissing.length ? ` (${topMissing.join(', ')})` : ''

  return [
    `Built and shipped production-ready features ${rolePart}${companyPart}, with clear ownership from implementation to testing.`,
    `Delivered measurable improvements using ${skillPhrase}, and documented architectural trade-offs for maintainability.`,
    `Collaborated across product and engineering to break down requirements into reliable deliverables and faster release cycles.`,
    `Improved profile fit by aligning project outcomes to JD expectations${gapPhrase} and quantifying impact in resume bullets.`,
  ]
}

const runLocalHeuristicAnalysis = (resumeText, jdText, role = '', company = '') => {
  const resumeKeywords = extractKeywords(resumeText)
  const jdKeywords = extractKeywords(jdText)
  const resumeSet = new Set(resumeKeywords)

  const matchedSkills = jdKeywords.filter((word) => resumeSet.has(word)).slice(0, 12)
  const missingSkills = jdKeywords.filter((word) => !resumeSet.has(word)).slice(0, 10)
  const fitScore = Math.min(
    100,
    Math.max(10, Math.round((matchedSkills.length / Math.max(jdKeywords.length, 1)) * 100)),
  )

  const suggestedBullets = buildBulletSuggestions(
    matchedSkills,
    missingSkills,
    role,
    company,
  )

  return {
    fitScore,
    matchedSkills,
    missingSkills,
    suggestedBullets,
    explanation: `Estimated fit is ${fitScore}% based on resume and job description keyword overlap.`,
  }
}

const formatAuthError = (error) => {
  const code = error?.code || 'auth/unknown'
  if (code === 'auth/popup-blocked') return 'Popup blocked. Allow popups and retry.'
  if (code === 'auth/popup-closed-by-user') return 'Google popup closed before login.'
  if (code === 'auth/cancelled-popup-request') return 'Sign-in request was replaced by a new attempt. Try once more.'
  if (code === 'auth/unauthorized-domain') return 'Add localhost in Firebase Auth authorized domains.'
  if (code === 'auth/operation-not-allowed') return 'Enable Google auth in Firebase Authentication.'
  if (code === 'auth/email-already-in-use') return 'This email is already registered. Use Sign in instead.'
  if (code === 'auth/invalid-email') return 'Please enter a valid email address.'
  if (code === 'auth/invalid-credential') return 'Invalid email or password.'
  if (code === 'auth/weak-password') return 'Password should be at least 6 characters.'
  if (code === 'auth/invalid-api-key') return 'Invalid Firebase API key in .env.'
  return `Google sign-in failed (${code}).`
}

const isValidHttpUrl = (value) => {
  if (!value?.trim()) return true
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const sanitizeInsights = (raw, resumeText, jdText, role, company) => {
  const fallback = runLocalHeuristicAnalysis(resumeText, jdText, role, company)
  if (!raw || typeof raw !== 'object') return fallback

  return {
    fitScore: Number.isFinite(Number(raw.fitScore))
      ? Math.min(100, Math.max(0, Number(raw.fitScore)))
      : fallback.fitScore,
    matchedSkills: Array.isArray(raw.matchedSkills)
      ? raw.matchedSkills.slice(0, 12).map((item) => String(item))
      : fallback.matchedSkills,
    missingSkills: Array.isArray(raw.missingSkills)
      ? raw.missingSkills.slice(0, 12).map((item) => String(item))
      : fallback.missingSkills,
    suggestedBullets: Array.isArray(raw.suggestedBullets)
      ? raw.suggestedBullets.slice(0, 5).map((item) => String(item))
      : fallback.suggestedBullets,
    explanation:
      typeof raw.explanation === 'string' && raw.explanation.trim()
        ? raw.explanation.trim()
        : fallback.explanation,
  }
}

const normalizeForSignature = (value) =>
  (value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const buildAnalysisSignature = ({ resumeText, jdText, role, company }) =>
  [
    normalizeForSignature(role),
    normalizeForSignature(company),
    normalizeForSignature(resumeText),
    normalizeForSignature(jdText),
  ].join('||')

const getDecisionLabelForStage = (app, fallbackForSaved) => {
  const stage = app.stage || 'applied'
  if (stage === 'saved') return fallbackForSaved
  if (stage === 'applied') return 'Already applied'
  if (stage === 'oa' || stage === 'interview') return 'In process'
  if (stage === 'offer') return 'Offer received'
  if (stage === 'reject') return 'Rejected'
  return fallbackForSaved
}

const CERTIFICATION_SIGNALS = [
  'certification',
  'certificate',
  'certified',
  'cert',
  'license',
  'licence',
  'aws solutions architect',
  'azure',
  'gcp',
  'snowpro',
  'databricks',
]

const hasMissingRequiredCertification = ({ missingSkills = [], fitExplanation = '' } = {}) => {
  const combinedText = [
    ...(missingSkills || []).map((skill) => String(skill).toLowerCase()),
    String(fitExplanation || '').toLowerCase(),
  ].join(' | ')

  return CERTIFICATION_SIGNALS.some((signal) => combinedText.includes(signal))
}

const clampFitScoreForCertification = (fitScore, missingRequiredCertification) => {
  const normalized = Number.isFinite(Number(fitScore)) ? Number(fitScore) : 0
  if (!missingRequiredCertification) {
    return Math.min(100, Math.max(0, Math.round(normalized)))
  }
  return Math.min(75, Math.max(65, Math.round(normalized)))
}

const buildDecisionAndActions = ({ fitScore, missingSkills, role, fitExplanation = '' }) => {
  const normalizedMissing = (missingSkills || []).map((skill) => String(skill).toLowerCase())
  const criticalSkillSignals = ['java', 'spring', 'system design', 'aws', 'sql', 'react', 'node']
  const criticalMissing = normalizedMissing.filter((skill) =>
    criticalSkillSignals.some((critical) => skill.includes(critical)),
  )
  const missingRequiredCertification = hasMissingRequiredCertification({
    missingSkills,
    fitExplanation,
  })
  const adjustedFitScore = clampFitScoreForCertification(fitScore, missingRequiredCertification)

  let decision = 'Improve then apply'
  let reason = 'Moderate fit; improve evidence for missing skills before applying.'

  if (missingRequiredCertification) {
    decision = 'Conditional / likely no-go unless recruiter confirms flexibility'
    reason =
      'A required certification appears missing. Proceed only if recruiter confirms flexibility on this requirement.'
  } else if (adjustedFitScore >= 75 && criticalMissing.length <= 1) {
    decision = 'Apply now'
    reason = 'Strong fit with manageable gaps. Prioritize this application.'
  } else if (adjustedFitScore < 45 || criticalMissing.length >= 4) {
    decision = 'Skip for now'
    reason = 'Significant gap on core requirements; better to prioritize stronger matches.'
  }

  const skillActions = criticalMissing.slice(0, 3).map((skill) =>
    `Add evidence only from real work for ${skill}; do not claim hands-on experience you do not have.`,
  )
  const certificationActions = missingRequiredCertification
    ? [
        'Pursuing certification: include current enrollment or exam timeline.',
        'Equivalent ETL experience (if applicable): map real projects to JD outcomes.',
        'Do not fabricate hands-on claims.',
      ]
    : []
  const roleAction = role
    ? `Align top 3 bullets to ${role} responsibilities using measurable outcomes.`
    : 'Align top 3 bullets to role responsibilities using measurable outcomes.'

  return {
    fitScore: adjustedFitScore,
    decision,
    reason,
    actionPlan: [
      ...certificationActions,
      ...skillActions,
      roleAction,
      'Mirror 5-8 key JD keywords naturally in resume/project bullets.',
      'Use one quantified impact line (latency, cost, scale, revenue, users).',
    ].slice(0, 5),
  }
}

let cachedPdfLib = null
let cachedPdfWorkerUrl = null
let cachedMammoth = null

const getPdfLib = async () => {
  if (!cachedPdfLib) {
    const module = await import('pdfjs-dist')
    cachedPdfLib = module
  }
  if (!cachedPdfWorkerUrl) {
    const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    cachedPdfWorkerUrl = workerModule.default
    cachedPdfLib.GlobalWorkerOptions.workerSrc = cachedPdfWorkerUrl
  }
  return cachedPdfLib
}

const getMammoth = async () => {
  if (!cachedMammoth) {
    const module = await import('mammoth')
    cachedMammoth = module.default
  }
  return cachedMammoth
}

const extractResumeTextFromFile = async (file) => {
  const fileName = file.name.toLowerCase()
  if (fileName.endsWith('.txt') || fileName.endsWith('.md')) {
    return file.text()
  }
  if (fileName.endsWith('.pdf')) {
    const pdfjsLib = await getPdfLib()
    const buffer = await file.arrayBuffer()
    const task = pdfjsLib.getDocument({ data: buffer })
    const pdf = await task.promise
    const pages = []
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => item.str).join(' '))
    }
    return pages.join('\n')
  }
  if (fileName.endsWith('.docx')) {
    const mammoth = await getMammoth()
    const buffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer: buffer })
    return result.value || ''
  }
  throw new Error('Unsupported file')
}

function ApplicationsListSection({
  allApps,
  visibleApps,
  loadingApps,
  searchQuery,
  statusFilter,
  decisionFilter,
  sortBy,
  onSearchChange,
  onStatusFilterChange,
  onDecisionFilterChange,
  onSortChange,
  onOpen,
}) {
  const stageCounts = allApps.reduce(
    (acc, app) => {
      const stage = app.stage || 'applied'
      acc.all += 1
      acc[stage] = (acc[stage] || 0) + 1
      return acc
    },
    { all: 0, saved: 0, applied: 0, oa: 0, interview: 0, offer: 0, reject: 0 },
  )

  const stageFilters = [
    { key: 'all', label: 'All' },
    { key: 'saved', label: 'Saved' },
    { key: 'applied', label: 'Applied' },
    { key: 'oa', label: 'OA' },
    { key: 'interview', label: 'Interview' },
    { key: 'offer', label: 'Offer' },
    { key: 'reject', label: 'Rejected' },
  ]

  const decisionFilters = [
    { key: 'all', label: 'All Decisions' },
    { key: 'Apply now', label: 'Apply now' },
    { key: 'Improve then apply', label: 'Improve' },
    {
      key: 'Conditional / likely no-go unless recruiter confirms flexibility',
      label: 'Conditional / no-go',
    },
    { key: 'Skip for now', label: 'Skip' },
    { key: 'Already applied', label: 'Already applied' },
    { key: 'In process', label: 'In process' },
    { key: 'Offer received', label: 'Offer received' },
    { key: 'Rejected', label: 'Rejected' },
    { key: 'Needs analysis', label: 'Needs analysis' },
  ]

  return (
    <section className="card">
      <div className="section-head">
        <h2>Applications</h2>
        <div className="list-controls">
          <input
            className="search-input"
            placeholder="Search role or company"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <select
            value={decisionFilter}
            onChange={(event) => onDecisionFilterChange(event.target.value)}
          >
            {decisionFilters.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <select value={sortBy} onChange={(event) => onSortChange(event.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="fit">Highest fit score</option>
          </select>
        </div>
      </div>
      <div className="filter-chips">
        {stageFilters.map((filter) => (
          <button
            key={filter.key}
            type="button"
            className={`chip ${statusFilter === filter.key ? 'chip-active' : ''}`}
            onClick={() => onStatusFilterChange(filter.key)}
          >
            {filter.label} ({stageCounts[filter.key] || 0})
          </button>
        ))}
      </div>
      {loadingApps ? <p className="placeholder">Loading applications...</p> : null}
      {!loadingApps && allApps.length === 0 ? <p className="placeholder">No applications yet.</p> : null}
      {!loadingApps && allApps.length > 0 && visibleApps.length === 0 ? (
        <p className="placeholder">No applications match the current filters.</p>
      ) : null}
      <div className="list">
        {visibleApps.map((app) => (
          <button
            key={app.id}
            className="application-summary"
            type="button"
            onClick={() => onOpen(app.id)}
          >
            <span>
              <span className="application-main">{app.role} @ {app.company}</span>
              <span className="application-meta">
                Applied: {app.appliedDate || '-'} | Fit: {typeof app.fitScore === 'number' ? `${app.fitScore}%` : 'N/A'}
              </span>
              {app.decisionLabel ? (
                <span className={`decision-badge decision-${app.decisionLabel.toLowerCase().replace(/\s+/g, '-')}`}>
                  {app.decisionLabel}
                </span>
              ) : null}
            </span>
            <span className={`status-badge status-${app.stage || 'applied'}`}>
              {app.stage || 'applied'}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ApplicationDetailSection({
  apps,
  uploadState,
  resumeInputs,
  jdInputs,
  analyzingId,
  onBack,
  onStageChange,
  onResumeInputChange,
  onJdInputChange,
  onResumeFileChange,
  onAnalyze,
  onDelete,
}) {
  const { applicationId } = useParams()
  const app = apps.find((item) => item.id === applicationId)
  const [tabState, setTabState] = useState({ appId: '', tab: 'overview' })
  const activeTab = tabState.appId === applicationId ? tabState.tab : 'overview'

  if (!app) {
    return (
      <section className="card detail-page">
        <p className="placeholder">Application not found or deleted.</p>
        <button type="button" className="secondary" onClick={onBack}>
          Back to list
        </button>
      </section>
    )
  }

  const detailDecisionLabel = getDecisionLabelForStage(
    app,
    app.decision || 'Needs analysis',
  )
  const computedInsights = typeof app.fitScore === 'number'
    ? buildDecisionAndActions({
        fitScore: Number(app.fitScore || 0),
        missingSkills: Array.isArray(app.missingSkills) ? app.missingSkills : [],
        role: app.role || '',
        fitExplanation: String(app.fitExplanation || ''),
      })
    : null
  const displayedFitScore =
    computedInsights && typeof computedInsights.fitScore === 'number'
      ? computedInsights.fitScore
      : app.fitScore
  const displayedDecisionLabel = computedInsights
    ? getDecisionLabelForStage(app, computedInsights.decision)
    : detailDecisionLabel
  const displayedReason = computedInsights?.reason || app.reason
  const displayedActionPlan =
    computedInsights?.actionPlan?.length ? computedInsights.actionPlan : app.actionPlan

  return (
    <section className="card detail-page">
      <p className="breadcrumb">Applications / {app.company} - {app.role}</p>
      <div className="detail-header">
        <h2>Application Details</h2>
        <div className="detail-actions">
          <button type="button" className="secondary" onClick={onBack}>
            Back to list
          </button>
          <button className="danger" onClick={() => onDelete(app.id)} type="button">
            Delete
          </button>
        </div>
      </div>

      <div className="tabs-row">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'overview' ? 'tab-btn-active' : ''}`}
          onClick={() => setTabState({ appId: applicationId, tab: 'overview' })}
        >
          Overview
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'resumejd' ? 'tab-btn-active' : ''}`}
          onClick={() => setTabState({ appId: applicationId, tab: 'resumejd' })}
        >
          Resume / JD
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'analysis' ? 'tab-btn-active' : ''}`}
          onClick={() => setTabState({ appId: applicationId, tab: 'analysis' })}
        >
          Analysis
        </button>
      </div>

      {activeTab === 'overview' ? (
        <div className="tab-panel">
          <p><strong>Role:</strong> {app.role}</p>
          <p><strong>Company:</strong> {app.company}</p>
          <p><strong>Applied Date:</strong> {app.appliedDate || '-'}</p>
          <div className="field">
            <label>Status</label>
            <select
              value={app.stage || 'applied'}
              onChange={(event) => onStageChange(app.id, event.target.value)}
            >
              <option value="saved">Saved</option>
              <option value="applied">Applied</option>
              <option value="oa">Online Assessment</option>
              <option value="interview">Interview</option>
              <option value="offer">Offer</option>
              <option value="reject">Rejected</option>
            </select>
          </div>
          {app.jobUrl ? (
            <p>
              <strong>Job Link:</strong>{' '}
              <a href={app.jobUrl} target="_blank" rel="noreferrer">
                Open posting
              </a>
            </p>
          ) : null}
          {app.notes ? <p><strong>Notes:</strong> {app.notes}</p> : <p className="subtext">No notes added.</p>}
        </div>
      ) : null}

      {activeTab === 'resumejd' ? (
        <div className="tab-panel ai-panel">
          <label>Resume Text (for this application)</label>
          <textarea
            rows={4}
            placeholder="Paste resume text used for this role..."
            value={resumeInputs[app.id] ?? app.resumeText ?? ''}
            onChange={(event) => onResumeInputChange(app.id, event.target.value)}
          />
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md"
            onChange={(event) => onResumeFileChange(app.id, event)}
          />
          {app.resumeFileName ? (
            <p className="subtext">
              Resume file: {app.resumeFileName}{' '}
              {app.resumeFileUrl ? (
                <a href={app.resumeFileUrl} target="_blank" rel="noreferrer">
                  View
                </a>
              ) : null}
              {uploadState === app.id ? ' (uploading...)' : ''}
            </p>
          ) : null}
          <label>Job Description (for AI analysis)</label>
          <textarea
            rows={4}
            placeholder="Paste job description here..."
            value={jdInputs[app.id] ?? app.jdText ?? ''}
            onChange={(event) => onJdInputChange(app.id, event.target.value)}
          />
        </div>
      ) : null}

      {activeTab === 'analysis' ? (
        <div className="tab-panel ai-panel">
          <button
            type="button"
            onClick={() => onAnalyze(app)}
            disabled={analyzingId === app.id}
          >
            {analyzingId === app.id ? 'Analyzing...' : 'Run AI Fit Analysis'}
          </button>

          {typeof app.fitScore === 'number' ? (
            <div className="insights">
              <p><strong>Fit Score:</strong> {displayedFitScore}%</p>
              {displayedDecisionLabel ? (
                <p><strong>Apply Decision:</strong> {displayedDecisionLabel}</p>
              ) : null}
              {displayedReason ? <p>{displayedReason}</p> : null}
              {app.fitExplanation ? <p>{app.fitExplanation}</p> : null}
              {app.missingSkills?.length ? (
                <p><strong>Missing Skills:</strong> {app.missingSkills.join(', ')}</p>
              ) : null}
              {displayedActionPlan?.length ? (
                <div>
                  <strong>Action Plan:</strong>
                  <ul>
                    {displayedActionPlan.map((action, index) => (
                      <li key={`${app.id}-action-${index}`}>{action}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {app.suggestedBullets?.length ? (
                <div>
                  <strong>Tailored Bullets:</strong>
                  <ul>
                    {app.suggestedBullets.map((bullet, index) => (
                      <li key={`${app.id}-bullet-${index}`}>{bullet}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="subtext">No analysis yet. Run AI fit analysis to generate insights.</p>
          )}
        </div>
      ) : null}
    </section>
  )
}

function App() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [apps, setApps] = useState([])
  const [loadingApps, setLoadingApps] = useState(false)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [formResumeFile, setFormResumeFile] = useState(null)
  const [uploadingFormResume, setUploadingFormResume] = useState(false)
  const [uploadingAppResumeId, setUploadingAppResumeId] = useState('')
  const [resumeInputs, setResumeInputs] = useState({})
  const [jdInputs, setJdInputs] = useState({})
  const [analyzingId, setAnalyzingId] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [formError, setFormError] = useState('')
  const [missingRequired, setMissingRequired] = useState({})
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [decisionFilter, setDecisionFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser)
      setLoadingAuth(false)

      if (!currentUser) return

      const userRef = doc(db, 'users', currentUser.uid)
      const existing = await getDoc(userRef)
      await setDoc(
        userRef,
        {
          email: currentUser.email ?? '',
          name: currentUser.displayName ?? 'User',
          ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user) {
      setApps([])
      return undefined
    }

    setLoadingApps(true)
    const appsQuery = query(
      collection(db, 'users', user.uid, 'applications'),
      orderBy('createdAt', 'desc'),
    )
    const unsub = onSnapshot(
      appsQuery,
      (snapshot) => {
        setApps(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
        setLoadingApps(false)
      },
      (snapshotError) => {
        setError(`Failed to fetch applications (${snapshotError?.code || 'unknown'}).`)
        setLoadingApps(false)
      },
    )
    return () => unsub()
  }, [user])

  const stats = useMemo(() => {
    const totals = {
      total: apps.length,
      saved: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      reject: 0,
    }
    for (const app of apps) {
      const stage = app.stage || 'applied'
      if (stage === 'saved') totals.saved += 1
      if (stage === 'applied') totals.applied += 1
      if (stage === 'interview' || stage === 'oa') totals.interview += 1
      if (stage === 'offer') totals.offer += 1
      if (stage === 'reject') totals.reject += 1
    }
    return totals
  }, [apps])

  const weeklyInsight = useMemo(() => {
    const sevenDaysAgo = dayjs().subtract(7, 'day')
    const weekly = apps.filter((app) => {
      const dateText = app.appliedDate || ''
      if (!dateText) return false
      const parsed = dayjs(dateText)
      return parsed.isValid() && parsed.isAfter(sevenDaysAgo)
    })

    if (weekly.length === 0) {
      return {
        summary: 'No applications added in last 7 days.',
        recommendation: 'Add 3 targeted Saved roles and run analysis before applying.',
      }
    }

    const interviews = weekly.filter((app) =>
      ['oa', 'interview', 'offer'].includes(app.stage || ''),
    ).length
    const responseRate = Math.round((interviews / weekly.length) * 100)
    const avgFit = Math.round(
      weekly.reduce((sum, app) => sum + Number(app.fitScore || 0), 0) /
        Math.max(weekly.length, 1),
    )

    return {
      summary: `Last 7 days: ${weekly.length} applications, ${responseRate}% reached OA/Interview/Offer, average fit ${avgFit}%.`,
      recommendation:
        avgFit < 60
          ? 'Average fit is low. Move more roles to Saved and optimize resume/JD alignment first.'
          : 'Average fit is healthy. Focus on faster apply cadence for high-fit roles.',
    }
  }, [apps])

  const appsWithDecision = useMemo(() => {
    return apps.map((app) => {
      if (typeof app.fitScore === 'number') {
        const inferred = buildDecisionAndActions({
          fitScore: Number(app.fitScore || 0),
          missingSkills: Array.isArray(app.missingSkills) ? app.missingSkills : [],
          role: app.role || '',
          fitExplanation: String(app.fitExplanation || ''),
        })
        return {
          ...app,
          fitScore:
            typeof inferred.fitScore === 'number'
              ? inferred.fitScore
              : Number(app.fitScore || 0),
          decisionLabel: getDecisionLabelForStage(app, inferred.decision),
        }
      }
      if (app.decision) {
        return {
          ...app,
          decisionLabel: getDecisionLabelForStage(app, app.decision),
        }
      }
      return {
        ...app,
        decisionLabel: getDecisionLabelForStage(app, 'Needs analysis'),
      }
    })
  }, [apps])

  const filteredApps = useMemo(() => {
    const bySearch = appsWithDecision.filter((app) => {
      const needle = searchQuery.trim().toLowerCase()
      if (!needle) return true
      const haystack = `${app.role || ''} ${app.company || ''}`.toLowerCase()
      return haystack.includes(needle)
    })

    const byStatus = bySearch.filter((app) => {
      if (statusFilter === 'all') return true
      return (app.stage || 'applied') === statusFilter
    })

    const byDecision = byStatus.filter((app) => {
      if (decisionFilter === 'all') return true
      return (app.decisionLabel || '') === decisionFilter
    })

    const sorted = [...byDecision]
    if (sortBy === 'oldest') {
      sorted.sort((a, b) => String(a.appliedDate || '').localeCompare(String(b.appliedDate || '')))
    } else if (sortBy === 'fit') {
      sorted.sort((a, b) => Number(b.fitScore || -1) - Number(a.fitScore || -1))
    } else {
      sorted.sort((a, b) => String(b.appliedDate || '').localeCompare(String(a.appliedDate || '')))
    }
    return sorted
  }, [appsWithDecision, searchQuery, sortBy, statusFilter, decisionFilter])

  const analyzePair = async ({ resumeText, jdText, role, company }) => {
    try {
      const analyzeJobFit = httpsCallable(functions, 'analyzeJobFit')
      const result = await analyzeJobFit({ resumeText, jdText, role, company })
      return {
        insights: sanitizeInsights(result?.data, resumeText, jdText, role, company),
        usedFallback: false,
      }
    } catch (analysisError) {
      const code = analysisError?.code ? ` (${analysisError.code})` : ''
      setError(`Cloud Function unavailable${code}. Used local heuristic analysis.`)
      return {
        insights: runLocalHeuristicAnalysis(resumeText, jdText, role, company),
        usedFallback: true,
      }
    }
  }

  const uploadResumeForPath = async (pathPrefix, file) => {
    const fileName = `${Date.now()}-${file.name}`
    const storageRef = ref(storage, `${pathPrefix}/${fileName}`)
    await uploadBytes(storageRef, file)
    const resumeFileUrl = await getDownloadURL(storageRef)
    return {
      resumeFileName: file.name,
      resumeFileUrl,
      resumeFileType: file.type || 'application/octet-stream',
      resumeFileSizeKb: Math.round((file.size || 0) / 1024),
    }
  }

  const handleGoogleLogin = async () => {
    if (isSigningIn) return
    setIsSigningIn(true)
    setError('')
    setInfo('')
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (authError) {
      if (authError?.code === 'auth/cancelled-popup-request') {
        setInfo('Sign-in popup was interrupted. Please click once and complete the popup.')
        return
      }
      if (authError?.code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, googleProvider)
        return
      }
      setError(formatAuthError(authError))
    } finally {
      setIsSigningIn(false)
    }
  }

  const handleEmailSignIn = async () => {
    setError('')
    setInfo('')
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.')
      return
    }

    setAuthLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      setInfo('Signed in successfully.')
    } catch (authError) {
      setError(formatAuthError(authError))
    } finally {
      setAuthLoading(false)
    }
  }

  const handleEmailSignUp = async () => {
    setError('')
    setInfo('')
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.')
      return
    }

    setAuthLoading(true)
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password)
      setInfo('Account created successfully.')
    } catch (authError) {
      setError(formatAuthError(authError))
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = async () => {
    await signOut(auth)
  }

  const handleFormChange = (event) => {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
    setFormError('')
    setMissingRequired((current) => ({ ...current, [name]: false }))
  }

  const handleFormResumeFileChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFormResumeFile(file)
    setForm((current) => ({ ...current, resumeFileName: file.name }))
    setFormError('')
    setMissingRequired((current) => ({ ...current, resumeFile: false }))
    setInfo('')
    setFormError('')
    try {
      const text = await extractResumeTextFromFile(file)
      setForm((current) => ({ ...current, resumeText: text }))
    } catch {
      setError('Could not extract text from this file. Use PDF, DOCX, TXT, or MD.')
    }
  }

  const handleCreateApplication = async (event) => {
    event.preventDefault()
    if (!user) return
    setFormError('')
    setMissingRequired({})
    const missingFields = []
    const missingMap = {}

    if (!form.company.trim() || !form.role.trim()) {
      if (!form.company.trim()) {
        missingFields.push('Company')
        missingMap.company = true
      }
      if (!form.role.trim()) {
        missingFields.push('Role')
        missingMap.role = true
      }
    }
    if (!formResumeFile) {
      missingFields.push('Resume file')
      missingMap.resumeFile = true
    }
    if (!form.jdText.trim()) {
      missingFields.push('Job description')
      missingMap.jdText = true
    }
    if (!form.appliedDate) {
      missingFields.push('Applied date')
      missingMap.appliedDate = true
    }

    if (missingFields.length > 0) {
      setError('')
      setInfo('')
      setMissingRequired(missingMap)
      setFormError(`Mandatory fields missing: ${missingFields.join(', ')}`)
      return
    }

    if (!isValidHttpUrl(form.jobUrl)) {
      setFormError('Job URL must start with http:// or https://')
      return
    }

    setUploadingFormResume(true)
    setError('')
    setInfo('')
    try {
      const resumeText = form.resumeText.trim()
      if (!resumeText) {
        setFormError('Resume text could not be extracted. Try another file or paste text manually.')
        setMissingRequired((current) => ({ ...current, resumeFile: true }))
        return
      }
      const uploadedResume = await uploadResumeForPath(`resumes/${user.uid}/new`, formResumeFile)
      const analysis = await analyzePair({
        resumeText,
        jdText: form.jdText.trim(),
        role: form.role.trim(),
        company: form.company.trim(),
      })
      await addDoc(collection(db, 'users', user.uid, 'applications'), {
        ...form,
        ...uploadedResume,
        resumeText,
        analysisInputSignature: buildAnalysisSignature({
          resumeText,
          jdText: form.jdText.trim(),
          role: form.role.trim(),
          company: form.company.trim(),
        }),
        company: form.company.trim(),
        role: form.role.trim(),
        fitScore: Number(analysis.insights.fitScore || 0),
        matchedSkills: Array.isArray(analysis.insights.matchedSkills)
          ? analysis.insights.matchedSkills
          : [],
        missingSkills: Array.isArray(analysis.insights.missingSkills)
          ? analysis.insights.missingSkills
          : [],
        suggestedBullets: Array.isArray(analysis.insights.suggestedBullets)
          ? analysis.insights.suggestedBullets
          : [],
        fitExplanation: String(analysis.insights.explanation || ''),
        ...buildDecisionAndActions({
          fitScore: Number(analysis.insights.fitScore || 0),
          missingSkills: Array.isArray(analysis.insights.missingSkills)
            ? analysis.insights.missingSkills
            : [],
          role: form.role.trim(),
          fitExplanation: String(analysis.insights.explanation || ''),
        }),
        analysisMode: analysis.usedFallback ? 'local' : 'cloud',
        analyzedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setForm(DEFAULT_FORM)
      setFormResumeFile(null)
      setMissingRequired({})
      setInfo('Application added and analyzed successfully.')
    } catch {
      setError('Failed to save application with resume upload.')
    } finally {
      setUploadingFormResume(false)
    }
  }

  const handleStageChange = async (appId, stage) => {
    if (!user) return
    setInfo('')
    await updateDoc(doc(db, 'users', user.uid, 'applications', appId), {
      stage,
      updatedAt: serverTimestamp(),
    })
    setInfo('Application stage updated.')
  }

  const handleDelete = async (appId) => {
    if (!user) return
    setInfo('')
    await deleteDoc(doc(db, 'users', user.uid, 'applications', appId))
    setInfo('Application deleted.')
    navigate('/')
  }

  const handleResumeInputChange = (appId, value) => {
    setResumeInputs((current) => ({ ...current, [appId]: value }))
  }

  const handleJdInputChange = (appId, value) => {
    setJdInputs((current) => ({ ...current, [appId]: value }))
  }

  const handleAppResumeFileChange = async (appId, event) => {
    if (!user) return
    const file = event.target.files?.[0]
    if (!file) return
    setUploadingAppResumeId(appId)
    setError('')
    setInfo('')
    try {
      const uploadedResume = await uploadResumeForPath(`resumes/${user.uid}/${appId}`, file)
      const text = await extractResumeTextFromFile(file)
      setResumeInputs((current) => ({ ...current, [appId]: text }))
      await updateDoc(doc(db, 'users', user.uid, 'applications', appId), {
        ...uploadedResume,
        resumeText: text,
        updatedAt: serverTimestamp(),
      })
      setInfo('Resume updated for this application.')
    } catch {
      setError('Resume upload failed. Ensure Storage is enabled and rules are deployed.')
    } finally {
      setUploadingAppResumeId('')
    }
  }

  const handleAnalyze = async (app) => {
    if (!user) return
    const resumeText = (resumeInputs[app.id] || app.resumeText || '').trim()
    const jdText = (jdInputs[app.id] || app.jdText || '').trim()
    if (!resumeText) {
      setError('Resume text is required for analysis.')
      return
    }
    if (!jdText) {
      setError('JD text is required for analysis.')
      return
    }

    const currentSignature = buildAnalysisSignature({
      resumeText,
      jdText,
      role: app.role,
      company: app.company,
    })
    if (
      app.analysisInputSignature &&
      app.analysisInputSignature === currentSignature &&
      typeof app.fitScore === 'number'
    ) {
      setInfo('No changes detected in resume/JD. Showing existing analysis result.')
      return
    }

    setAnalyzingId(app.id)
    setError('')
    setInfo('')
    try {
      const analysis = await analyzePair({
        resumeText,
        jdText,
        role: app.role,
        company: app.company,
      })
      await updateDoc(doc(db, 'users', user.uid, 'applications', app.id), {
        resumeText,
        jdText,
        fitScore: Number(analysis.insights.fitScore || 0),
        matchedSkills: Array.isArray(analysis.insights.matchedSkills)
          ? analysis.insights.matchedSkills
          : [],
        missingSkills: Array.isArray(analysis.insights.missingSkills)
          ? analysis.insights.missingSkills
          : [],
        suggestedBullets: Array.isArray(analysis.insights.suggestedBullets)
          ? analysis.insights.suggestedBullets
          : [],
        fitExplanation: String(analysis.insights.explanation || ''),
        ...buildDecisionAndActions({
          fitScore: Number(analysis.insights.fitScore || 0),
          missingSkills: Array.isArray(analysis.insights.missingSkills)
            ? analysis.insights.missingSkills
            : [],
          role: app.role,
          fitExplanation: String(analysis.insights.explanation || ''),
        }),
        analysisMode: analysis.usedFallback ? 'local' : 'cloud',
        analysisInputSignature: currentSignature,
        analyzedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setInfo('Analysis updated.')
    } catch {
      setError('Failed to update application analysis.')
    } finally {
      setAnalyzingId('')
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Job Intelligence Tracker</h1>
          <p>Track applications and build your interview pipeline.</p>
        </div>
        <div className="auth-actions">
          {!user ? (
            <button onClick={handleGoogleLogin} disabled={isSigningIn}>
              {isSigningIn ? 'Signing in...' : 'Sign in with Google'}
            </button>
          ) : (
            <>
              <span className="user-email">{user.email}</span>
              <button className="secondary" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className="error-message">{error}</p>}
      {info && <p className="info-message">{info}</p>}
      {loadingAuth ? <p className="placeholder">Checking authentication...</p> : null}

      {!user && !loadingAuth ? (
        <section className="card">
          <h2>Start Here</h2>
          <p>Sign in to manage your applications and AI analysis.</p>
          <div className="auth-form">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div className="auth-buttons">
              <button type="button" className="secondary" onClick={handleEmailSignIn} disabled={authLoading}>
                {authLoading ? 'Please wait...' : 'Sign in with Email'}
              </button>
              <button type="button" onClick={handleEmailSignUp} disabled={authLoading}>
                {authLoading ? 'Please wait...' : 'Sign up with Email'}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {user ? (
        <>
          <section className="stats-grid">
            <article className="card stat">
              <h3>Total</h3>
              <p>{stats.total}</p>
            </article>
            <article className="card stat">
              <h3>Saved</h3>
              <p>{stats.saved}</p>
            </article>
            <article className="card stat">
              <h3>Applied</h3>
              <p>{stats.applied}</p>
            </article>
            <article className="card stat">
              <h3>Interview/OA</h3>
              <p>{stats.interview}</p>
            </article>
            <article className="card stat">
              <h3>Offers</h3>
              <p>{stats.offer}</p>
            </article>
            <article className="card stat">
              <h3>Rejected</h3>
              <p>{stats.reject}</p>
            </article>
          </section>

          <section className="card">
            <h2>Weekly Strategy Insight</h2>
            <p>{weeklyInsight.summary}</p>
            <p className="subtext">{weeklyInsight.recommendation}</p>
          </section>

          <section className="card">
            <h2>Add Application</h2>
            <p className="required-legend">Fields marked with * are mandatory.</p>
            <form className="form-grid" onSubmit={handleCreateApplication}>
              <div className={`field ${missingRequired.company ? 'field-error' : ''}`}>
                <label>Company *</label>
                <input name="company" placeholder="Company" value={form.company} onChange={handleFormChange} />
              </div>
              <div className={`field ${missingRequired.role ? 'field-error' : ''}`}>
                <label>Role *</label>
                <input name="role" placeholder="Role" value={form.role} onChange={handleFormChange} />
              </div>
              <div className="field">
                <label>Stage</label>
                <select name="stage" value={form.stage} onChange={handleFormChange}>
                  <option value="saved">Saved</option>
                  <option value="applied">Applied</option>
                  <option value="oa">Online Assessment</option>
                  <option value="interview">Interview</option>
                  <option value="offer">Offer</option>
                  <option value="reject">Rejected</option>
                </select>
              </div>
              <div className={`field ${missingRequired.appliedDate ? 'field-error' : ''}`}>
                <label>Applied Date *</label>
                <input type="date" name="appliedDate" value={form.appliedDate} onChange={handleFormChange} />
              </div>
              <div className="field">
                <label>Job URL (optional)</label>
                <input name="jobUrl" placeholder="https://..." value={form.jobUrl} onChange={handleFormChange} />
              </div>
              <div className="field field-full">
                <label>Notes (optional)</label>
                <textarea
                  name="notes"
                  placeholder="Use for recruiter details, referral notes, interview feedback, reminders..."
                  rows={3}
                  value={form.notes}
                  onChange={handleFormChange}
                />
              </div>
              <div className={`field field-full ${missingRequired.resumeFile ? 'field-error' : ''}`}>
                <label>Resume File *</label>
                <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFormResumeFileChange} />
              </div>
              {form.resumeFileName ? <p className="subtext">Selected resume: {form.resumeFileName}</p> : null}
              <div className="field field-full">
                <label>Resume Text (auto-filled from file)</label>
                <textarea
                  name="resumeText"
                  placeholder="Resume text (auto-filled from file when possible)"
                  rows={4}
                  value={form.resumeText}
                  onChange={handleFormChange}
                />
              </div>
              <div className={`field field-full ${missingRequired.jdText ? 'field-error' : ''}`}>
                <label>Job Description Text *</label>
                <textarea
                  name="jdText"
                  placeholder="Paste JD text for this application"
                  rows={4}
                  value={form.jdText}
                  onChange={handleFormChange}
                />
              </div>
              {formError ? <p className="form-error">{formError}</p> : null}
              <button type="submit" disabled={uploadingFormResume}>
                {uploadingFormResume ? 'Saving...' : 'Save Application'}
              </button>
            </form>
          </section>

          <Routes>
            <Route
              path="/"
              element={(
                <ApplicationsListSection
                  allApps={appsWithDecision}
                  visibleApps={filteredApps}
                  loadingApps={loadingApps}
                  searchQuery={searchQuery}
                  statusFilter={statusFilter}
                  decisionFilter={decisionFilter}
                  sortBy={sortBy}
                  onSearchChange={setSearchQuery}
                  onStatusFilterChange={setStatusFilter}
                  onDecisionFilterChange={setDecisionFilter}
                  onSortChange={setSortBy}
                  onOpen={(id) => navigate(`/applications/${id}`)}
                />
              )}
            />
            <Route
              path="/applications/:applicationId"
              element={(
                <ApplicationDetailSection
                  apps={apps}
                  uploadState={uploadingAppResumeId}
                  resumeInputs={resumeInputs}
                  jdInputs={jdInputs}
                  analyzingId={analyzingId}
                  onBack={() => navigate('/')}
                  onStageChange={handleStageChange}
                  onResumeInputChange={handleResumeInputChange}
                  onJdInputChange={handleJdInputChange}
                  onResumeFileChange={handleAppResumeFileChange}
                  onAnalyze={handleAnalyze}
                  onDelete={handleDelete}
                />
              )}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </>
      ) : null}
    </main>
  )
}

export default App
