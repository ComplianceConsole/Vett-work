const https = require('https')

function fetchUrl(url) {
  return new Promise((resolve,reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':'text/html',
      }
    }, res => {
      let data=''
      res.on('data',c=>data+=c)
      res.on('end',()=>resolve({status:res.statusCode,body:data}))
    })
    req.on('error',reject)
  })
}

async function main() {
  const res = await fetchUrl('https://au.jora.com/Information-Communication-Technology-jobs?sort=date&p=1')
  const html = res.body
  console.log('Status:', res.status)
  console.log('Size:', html.length)
  
  const ids = html.match(/id="r_([a-f0-9]{32})"/g) || []
  console.log('IDs found:', ids.length)
  
  if (ids.length > 0) {
    const id = ids[0]
    const start = html.indexOf(id)
    const block = html.substring(start, start + 2000)
    console.log('\nFirst card block:')
    console.log(block.substring(0, 800))
  }
}
main().catch(console.error)
