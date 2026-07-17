#!/usr/bin/env node
// Download climate datasets from the Met Office into src/data/.
// Run once (or to refresh): npm run fetch-data

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const OUT_DIR = new URL('../src/data/', import.meta.url).pathname

async function get(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// Input columns: Time ("1850-01"), Anomaly (deg C), Lower CI (2.5%), Upper CI (97.5%).
async function fetchHadCRUT5() {
  const url =
    'https://www.metoffice.gov.uk/hadobs/hadcrut5/data/HadCRUT.5.1.0.0/analysis/diagnostics/' +
    'HadCRUT.5.1.0.0.analysis.summary_series.global.monthly.csv'
  console.log('Fetching HadCRUT5 monthly …')
  const raw = await get(url)
  const lines = raw.trim().split('\n')
  const rows = ['year_month,anomaly_c,lower_ci,upper_ci']
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(s => s.trim())
    if (cols.length < 4) continue
    rows.push(cols.slice(0, 4).join(','))
  }
  return rows.join('\n') + '\n'
}

// Input is fixed-width text: rows = years, cols = months Jan…Dec + annual.
// Reshaped to long-form year_month,temp_c (annual column skipped).
async function fetchHadUKGrid() {
  const url =
    'https://www.metoffice.gov.uk/hadobs/hadukgrid/data/uk/Time_series/meantemp/' +
    'UK_meantemp_monthly_grouped.txt'
  console.log('Fetching HadUK-Grid UK mean temperature …')
  const raw = await get(url)
  const lines = raw.trim().split('\n')
  const rows = ['year_month,temp_c']
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Year')) continue
    // Typical line: "1884   4.0   4.0   5.2   7.2   9.7  12.2  14.3  14.3  12.3   9.4   5.9   4.5  8.6"
    const parts = trimmed.split(/\s+/)
    if (parts.length < 13) continue
    const year = parts[0]
    for (let m = 1; m <= 12; m++) {
      const val = parts[m]
      if (!val || val === '---' || val === 'NaN') continue
      const month = String(m).padStart(2, '0')
      rows.push(`${year}-${month},${val}`)
    }
  }
  return rows.join('\n') + '\n'
}

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true })

  const [hadcrut5, haduk] = await Promise.all([
    fetchHadCRUT5().catch(e => { console.error('HadCRUT5 failed:', e.message); return null }),
    fetchHadUKGrid().catch(e => { console.error('HadUK-Grid failed:', e.message); return null }),
  ])

  if (hadcrut5) {
    await writeFile(OUT_DIR + 'hadcrut5-monthly.csv', hadcrut5)
    const n = hadcrut5.split('\n').length - 2
    console.log(`  → src/data/hadcrut5-monthly.csv  (${n} rows)`)
  }
  if (haduk) {
    await writeFile(OUT_DIR + 'haduk-meantemp-monthly.csv', haduk)
    const n = haduk.split('\n').length - 2
    console.log(`  → src/data/haduk-meantemp-monthly.csv  (${n} rows)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
