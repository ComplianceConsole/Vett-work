// vett.work Jora scraper - run locally with: node jora-scraper.js [batch]
const https = require('https')

const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzZGpsZmRvZGF1dXdxc3BqcGFlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTQyNzIxNiwiZXhwIjoyMDk1MDAzMjE2fQ.vHj5b_TGjrwWJyNHtPu7yF-J7LYHdPLLz8eHgRV9Tms'

const AGENCY_KEYWORDS = ['recruitment','recruiting','staffing','talent solutions','hays','robert half','hudson','randstad','adecco','michael page','people2people','chandler macleod','skilled group','drake','korn ferry']

const BATCHES = {
  tech:           [{country:'au',category:'technology',jora:'Information-Communication-Technology',pages:5},{country:'nz',category:'technology',jora:'Information-Communication-Technology',pages:2}],
  accounting:     [{country:'au',category:'accounting',jora:'Accounting',pages:5},{country:'nz',category:'accounting',jora:'Accounting',pages:2}],
  hr:             [{country:'au',category:'hr',jora:'Human-Resources-Recruitment',pages:5},{country:'nz',category:'hr',jora:'Human-Resources-Recruitment',pages:2}],
  marketing:      [{country:'au',category:'marketing',jora:'Marketing-Communications',pages:5},{country:'nz',category:'marketing',jora:'Marketing-Communications',pages:2}],
  sales:          [{country:'au',category:'sales',jora:'Sales',pages:5},{country:'nz',category:'sales',jora:'Sales',pages:2}],
  leadership:     [{country:'au',category:'leadership',jora:'General-Management',pages:5},{country:'nz',category:'leadership',jora:'General-Management',pages:2}],
  legal:          [{country:'au',category:'legal',jora:'Legal',pages:5},{country:'nz',category:'legal',jora:'Legal',pages:2}],
  consulting:     [{country:'au',category:'consulting',jora:'Consulting-Strategy',pages:5},{country:'nz',category:'consulting',jora:'Consulting-Strategy',pages:2}],
  banking:        [{country:'au',category:'banking',jora:'Banking-Financial-Services',pages:5},{country:'nz',category:'banking',jora:'Banking-Financial-Services',pages:2}],
  community:      [{country:'au',category:'community',jora:'Community-Services-Development',pages:5},{country:'nz',category:'community',jora:'Community-Services-Development',pages:2}],
  healthcare:     [{country:'au',category:'healthcare',jora:'Healthcare-Medical',pages:5},{country:'nz',category:'healthcare',jora:'Healthcare-Medical',pages:2}],
  administration: [{country:'au',category:'administration',jora:'Administration-Office-Support',pages:5},{country:'nz',category:'administration',jora:'Administration-Office-Support',pages:2}],
  engineering:    [{country:'au',category:'engineering',jora:'Engineering',pages:5},{country:'nz',category:'engineering',jora:'Engineering',pages:2}],
  education:      [{country:'au',category:'education',jora:'Education-Training',pages:5},{country:'nz',category:'education',jora:'Education-Training',pages:2}],
  realestate:     [{country:'au',category:'realestate',jora:'Real-Estate-Property',pages:5},{country:'nz',category:'realestate',jora:'Real-Estate-Property',pages:2}],
}

function isAgency(name) { const l=(name||'').toLowerCase(); return AGENCY_KEYWORDS.some(k=>l.includes(k)) }
function clean(s) { return (s||'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/([.!?])([A-Z])/g,'$1 $2').replace(/\s+/g,' ').trim() }
function shortDesc(d) { const c=clean(d); if(c.length<=200)return c; const cut=c.substring(0,197); return cut.substring(0,cut.lastIndexOf(' '))+'...' }
function mapEmp(b) { const t=(b||'').toLowerCase(); if(t.includes('part'))return'parttime'; if(t.includes('casual')||t.includes('temp'))return'casual'; if(t.includes('contract'))return'contractor'; return'fulltime' }
function mapWork(t) { const s=(t||'').toLowerCase(); if(s.includes('remote'))return'remote'; if(s.includes('hybrid'))return'hybrid'; return'office' }
function extract(html,cls) { const m=html.match(new RegExp('class="'+cls+'"[^>]*>([^<]*)')); return m?clean(m[1]):'' }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)) }

function fetchUrl(url) {
  return new Promise((resolve,reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':'text/html,application/xhtml+xml',
        'Accept-Language':'en-AU,en;q=0.9',
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject)
      }
      let data=''
      res.on('data',c=>data+=c)
      res.on('end',()=>resolve({status:res.statusCode,body:data}))
    })
    req.on('error',reject)
    req.setTimeout(20000,()=>{req.destroy();reject(new Error('timeout'))})
  })
}

async function sbGet(path) {
  return new Promise((resolve,reject) => {
    const opts = { hostname:'gsdjlfdodauuwqspjpae.supabase.co', path:'/rest/v1/'+path, method:'GET',
      headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY} }
    const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch{resolve([])} }) })
    req.on('error',reject); req.end()
  })
}

async function sbPost(path, body) {
  return new Promise((resolve,reject) => {
    const payload = JSON.stringify(body)
    const opts = { hostname:'gsdjlfdodauuwqspjpae.supabase.co', path:'/rest/v1/'+path, method:'POST',
      headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=representation','Content-Length':Buffer.byteLength(payload)} }
    const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch{resolve(null)} }) })
    req.on('error',reject); req.write(payload); req.end()
  })
}

async function scrapePage(country, category, joraCategory, page) {
  const base = country==='au' ? 'https://au.jora.com' : 'https://nz.jora.com'
  const url = `${base}/${joraCategory}-jobs?sp=facets&ca=${joraCategory.toLowerCase().replace(/-/g,'_')}&sort=date&p=${page}`

  let html
  try {
    const res = await fetchUrl(url)
    if (res.status !== 200) { console.log(`  HTTP ${res.status}`); return 0 }
    html = res.body
  } catch(e) { console.log(`  fetch error: ${e.message}`); return 0 }

  const ids = html.match(/id="r_([a-f0-9]{32})"/g) || []
  console.log(`  ${ids.length} cards found in HTML`)
  if (ids.length === 0) {
    // Check if page has any content
    const hasJobs = html.includes('job-card') || html.includes('job-link')
    console.log(`  job-card in HTML: ${hasJobs}, HTML size: ${html.length}`)
    return 0
  }

  // Split HTML by card IDs
  let inserted = 0
  for (const idAttr of ids) {
    try {
      const idMatch = idAttr.match(/r_([a-f0-9]{32})/)
      if (!idMatch) continue
      const id = idMatch[1]

      // Get block between this id and next
      const start = html.indexOf(idAttr)
      const nextStart = html.indexOf('id="r_', start + 10)
      const block = nextStart > 0 ? html.substring(start, nextStart) : html.substring(start, start + 3000)

      const titleM = block.match(/class="job-link"[^>]*>([^<]+)</)
      const title = titleM ? clean(titleM[1]) : ''
      if (!title) continue

      const company = extract(block, 'job-company')
      if (!company || isAgency(company)) continue

      const location = extract(block, 'job-location')
      const snippet = extract(block, 'job-abstract')
      if (!snippet || snippet.length < 30) continue

      const dateText = extract(block, 'job-listed-date')
      if (dateText && (dateText.includes('30d') || dateText.includes('14d'))) continue

      const empBadge = extract(block, 'job-type') || extract(block, 'badges')
      const urlM = block.match(/href="(https?:\/\/[^"]*jora[^"]*)"/)
      const jobUrl = urlM ? urlM[1] : ''
      const externalRef = `jora_${id}`

      const existing = await sbGet(`jobs?select=id&external_reference=eq.${externalRef}&limit=1`)
      if (existing && existing.length > 0) continue

      let employerId = null
      const empCheck = await sbGet(`employers?select=id&company_name=eq.${encodeURIComponent(company)}&source=eq.jora&limit=1`)
      if (empCheck && empCheck.length > 0) {
        employerId = empCheck[0].id
      } else {
        const empCreate = await sbPost('employers', { company_name:company, source:'jora', email:`jora_${id}@placeholder.vettwork.internal`, company_type:'direct' })
        if (empCreate && empCreate[0]) employerId = empCreate[0].id
      }
      if (!employerId) continue

      await sbPost('jobs', {
        employer_id:employerId, title, description:snippet,
        short_description:shortDesc(snippet), location,
        employment_type:mapEmp(empBadge), work_type:mapWork(empBadge+' '+snippet),
        category, is_active:false, status:'pending_review',
        expires_at:new Date(Date.now()+7*24*60*60*1000).toISOString(),
        external_reference:externalRef, application_url:jobUrl||null, source:'jora'
      })
      inserted++
      process.stdout.write('.')
    } catch(e) { console.log("  job error:", e.message) }
  }
  console.log(`\n  inserted: ${inserted}`)
  return inserted
}

async function main() {
  const batch = process.argv[2] || 'tech'
  const runs = BATCHES[batch]
  if (!runs) { console.log('Unknown batch. Available: '+Object.keys(BATCHES).join(', ')); process.exit(1) }
  console.log(`\n Running batch: ${batch}\n`)
  let total = 0
  for (const run of runs) {
    for (let page=1; page<=run.pages; page++) {
      process.stdout.write(`Fetching ${run.country}/${run.jora} p${page}... `)
      total += await scrapePage(run.country, run.category, run.jora, page)
      await sleep(1500)
    }
  }
  console.log(`\n Done! ${total} new jobs added to review queue.`)
}

main().catch(console.error)
