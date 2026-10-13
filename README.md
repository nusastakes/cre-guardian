# nusastakes/cre-guardian

Workflow Chainlink CRE **"City Guardian"** untuk **Nusastakes**, dengan dua handler:

- **Trigger 0, Satpam:** memantau kota (vault ERC-4626) dan, bila risikonya tinggi, meminta kontrak `CityGuardian` menarik
  dana kota dari adapter kembali ke idle.
- **Trigger 1, penulis APY (14 Okt 2026):** tiap 2 menit mengambil satu layanan katalog secara bergiliran, membaca APY
  pool-nya dari DefiLlama Yields (disepakati node), lalu menulis laporan ke `ApyFeed`. Dengan begitu bunga yang
  menggerakkan imbal hasil simulasi semua kota tidak hanya bergantung pada kunci relayer.

> **Status:** kode workflow, tes, dan binding kontrak lulus (55 tes bun, 14 Okt 2026). **Sudah dijalankan di simulator
> CRE:** Satpam (13 Okt) mengirim laporan lewat forwarder simulasi ke `CityGuardian` di Monad testnet dan mengevakuasi
> adapter kota demo (tx `0x10749bb7f363aaeae6461b6d3f31175921148f79da323baa478c3251a6332cca`); penulis APY (14 Okt) menulis
> APY Euler 894 bps ke `ApyFeed` (tx `0x2ce46255cb3ee44ff6165ce04e4ec08a5e43f5a5da7bcf9b9875f73512a8caa6`). Lihat bagian
> "Simulasi". **Belum diuji** di jaringan DON sungguhan dengan forwarder produksi: itu butuh Deploy Access dari Chainlink.

## Cara kerja

Dipicu cron tiap 10 menit. Satu putaran:

1. **Baca rantai.** `CityFactory.cityInfos` (satu panggilan untuk semua kota), lalu per kota yang walikotanya sudah
   mengaktifkan Satpam CRE: `highWaterMark` vault dan `totalAssets` tiap adapter. Kota yang belum mengaktifkan Satpam
   dilewati, karena kontrak akan menolak laporannya.
2. **Baca sumber di luar rantai.** API GraphQL Morpho untuk vault AUSD mainnet yang ditiru yield simulasi (peringatan
   RED/YELLOW, `netApy`).
3. **Nilai risiko dengan aturan yang pasti.** Harga share jauh di bawah high-water mark, peringatan RED di sumber, atau
   APY sumber yang tidak wajar. Sumber yang tidak terjangkau **bukan** alasan evakuasi.
4. **Minta pendapat kedua dari LLM, hanya bila ada yang janggal.** Putaran tenang tidak memanggil LLM sama sekali.
5. **Gabungkan.** LLM boleh menaikkan risiko yang sudah terlihat aturan (MEDIUM menjadi HIGH, LOW menjadi MEDIUM), tetapi
   tidak boleh membuat evakuasi sendirian dari LOW dan tidak boleh menurunkan risiko.
6. **Evakuasi bila HIGH.** Untuk setiap adapter yang masih berisi dana, kirim satu laporan ke `CityGuardian`; adapter
   kosong dilewati supaya gas tidak terbuang.

Jaminan keamanan yang datang dari kontrak, bukan dari workflow: laporan hanya bisa menarik dana ke idle; hanya berlaku
untuk kota yang walikotanya memberi peran Satpam ke `CityGuardian.CRE_SATPAM()`; muatan harus menyebut kontrak
guardian dan chain selector yang benar; `scheduledAt` harus naik untuk setiap pasangan kota+adapter (menolak replay);
dan laporan ditolak sampai identitas workflow dikunci (`expectedAuthor` atau `expectedWorkflowId`). Evakuasi tidak
pernah mengirim dana ke pihak ketiga.

## Isi repo

| Jalur | Fungsi |
| --- | --- |
| `city-guardian/workflow.ts` | Workflow: pembacaan rantai, HTTP, penilaian, laporan |
| `city-guardian/risk.ts` | Aturan risiko, penggabungan dengan LLM, enkode muatan laporan (murni, tanpa SDK) |
| `city-guardian/llm.ts` | Permintaan dan parsing balasan LLM untuk dua provider |
| `city-guardian/apyfeed.ts` | Handler kedua (trigger 1): pilih sumber per slot waktu, baca `ApyFeed.latest`, ambil `/chart/<pool>` DefiLlama, tulis laporan `abi.encode(target, sourceId, apyBps, observedAt, chainSelector)` |
| `city-guardian/*.test.ts` | 55 tes (`bun test`) |
| `city-guardian/config.{staging,production}.json` | Parameter: jadwal, alamat kontrak, ambang, provider LLM |
| `contracts/evm/src/abi/` | ABI ringkas (hanya fungsi yang dipakai workflow) dari repo `contracts` |
| `contracts/evm/ts/generated/` | Binding TypeScript hasil `cre generate-bindings evm` |
| `project.yaml`, `secrets.yaml` | RPC per target dan daftar nama rahasia |

## Konfigurasi

`city-guardian/config.staging.json` (ambang dalam basis poin; `maxCities` paling banyak 3 supaya tetap di bawah kuota
15 pembacaan EVM per eksekusi; `firstCity` = indeks kota pertama di factory yang dipantau; `rotate: true` membuat
setiap putaran cron memantau jendela berikutnya sehingga semua kota tercakup, lihat "Keterbatasan"):

```json
{
  "schedule": "0 */10 * * * *",
  "chainSelectorName": "monad-testnet",
  "factoryAddress": "0xDC9A322E95E7d9214fA794D39534a15B4aB3d9fF",
  "guardianAddress": "0x74f881ec300dfd1bfd26b4c0392f713fc775e7b9",
  "maxCities": 3,
  "firstCity": 0,
  "thresholds": { "drawdownHighBps": 200, "drawdownMediumBps": 50, "apyOutlierPct": 25 },
  "llm": { "provider": "anthropic", "model": "claude-sonnet-5-5", "maxTokens": 600 },
  "source": { "morphoApi": "https://blue-api.morpho.org/graphql", "vault": "0x32841A8511D5c2c5b253f45668780B99139e476D", "chainId": 143 },
  "gasLimit": "450000"
}
```

Blok `apyFeed` (opsional; tanpa blok ini hanya Satpam yang terdaftar) berisi `feedAddress` (`ApyFeed`
`0x3328AEbB57Ee0bc8d2C7f68468dEe6B9b50926b5`), `schedule` (`0 */2 * * * *`), `rotationSeconds` (120), dan `sources`
(17 layanan katalog `{ id, pool }`; `sourceId` = keccak256 id pool, aturan yang sama dengan kontrak, relayer, dan web).
APY di atas 50% ditulis 5000 bps (batas feed). `observedAt` = waktu DON dikurangi 30 detik, dan laporan tidak dikirim bila
feed sudah punya bacaan yang lebih baru (keeper relayer juga menulis sumber yang sama).

**LLM.** `provider` bisa `anthropic` (`https://api.anthropic.com/v1/messages`, model `claude-sonnet-5-5`), `xkiro`
(gateway yang kompatibel dengan format Anthropic dan OpenAI di `https://api.xkiro.com/v1/messages`; ID model memakai
awalan vendor dan diambil dari `GET /v1/models`, bukan ditebak), atau `none` (hanya aturan). Diperiksa dengan panggilan
nyata pada 13 Okt 2026 memakai pembuat permintaan workflow ini: Anthropic `claude-sonnet-5-5` dan xKiro
`anthropic/claude-sonnet-5` sama-sama membalas 200 dengan JSON yang lolos parser. Daftar model xKiro pada hari itu tidak
memuat `claude-sonnet-5-5`; padanan terdekatnya `anthropic/claude-sonnet-5`. Kuncinya `ANTHROPIC_API_KEY`
atau `XKIRO_API_KEY`, dibaca lewat rahasia CRE, tidak pernah ditaruh di konfigurasi atau repo. Tanpa kunci, workflow
tetap jalan hanya dengan aturan. Catatan: pada HTTP biasa kunci terlihat oleh node yang memanggil; untuk produksi
sungguhan pakai Confidential HTTP.

**Demo.** `demoForceHighCity` (alamat vault) memaksa risiko HIGH untuk satu kota supaya evakuasi bisa ditunjukkan di
video; kosongkan di luar demo.

## Menjalankan tes

```
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$PATH"       # lokasi CLI CRE dan Bun bila dipasang manual
cd city-guardian && bun install
bun run typecheck
bun test
```

Tes memakai mock resmi SDK untuk EVM, HTTP, dan rahasia, dan mencakup: aturan risiko, penggabungan LLM (LLM tidak bisa
membuat atau menurunkan risiko), kedua provider, kegagalan LLM, kunci yang tidak boleh bocor ke prompt, kota yang
belum mengaktifkan Satpam, adapter kosong, transaksi laporan gagal, dan muatan laporan yang cocok persis dengan
`CityGuardian` di Solidity (ada juga fixture lintas bahasa di `contracts/test/CityGuardian.t.sol`).

## Simulasi (butuh akun CRE)

1. Buat akun di https://app.chain.link/cre/discover (dengan 2FA), lalu `cre login` (terminal biasa; membuka browser).
   Simulasi tidak butuh Deploy Access.
2. Isi `.env` dari `.env.example`: `CRE_ETH_PRIVATE_KEY` (kunci testnet khusus simulator, butuh sedikit MON bila memakai
   `--broadcast`) dan kunci LLM bila ingin pendapat kedua.
3. Simulasi baca-saja: `cre workflow simulate city-guardian --target staging-settings --non-interactive --trigger-index 0`.
   Kota yang walikotanya belum mengaktifkan Satpam dilewati, jadi hasilnya "skipped".
4. Simulasi yang menulis ke Monad testnet (`--broadcast`) butuh persiapan on-chain yang dilakukan `city-guardian/demo.ts`
   (membaca `.env` lewat `set -a; . ../../.env; . ../.env; set +a`):
   - `bun run demo.ts setup`: mendirikan kota "Satpam demo" (walikota = wallet deployer), mengisinya dari faucet relayer,
     memindahkan setengahnya ke adapter mirror, mengaktifkan `CRE_SATPAM` untuk kota itu, mengarahkan `CityGuardian` ke
     forwarder simulasi `0xB9F79d863261869B234c481D1f9A7af84AeAd192` dengan `setIdentityEnforced(false)`, dan mendanai
     kunci simulator dengan 2 MON.
   - Isi `demoForceHighCity` (alamat vault kota demo) dan `firstCity` (indeks kota itu dikurangi 2) di config, lalu
     `cre workflow simulate city-guardian --target staging-settings --broadcast --non-interactive --trigger-index 0`.
   - `bun run demo.ts restore`: mengembalikan forwarder asli dan `identityEnforced=true` dan mencabut Satpam kota demo.
     `bun run demo.ts status` menunjukkan keadaan sekarang.
   Selama guardian memakai forwarder simulasi, siapa pun bisa mengirim laporan ke sana (forwarder itu tidak memeriksa
   tanda tangan), tetapi hanya untuk kota yang mengaktifkan Satpam dan efeknya hanya menarik dana ke idle. Jangan
   dijalankan di mainnet.

5. Penulis APY (trigger 1), baca-saja: `cre workflow simulate city-guardian --target staging-settings --non-interactive --trigger-index 1`.
   Untuk `--broadcast`, `ApyFeed` harus sementara diarahkan ke forwarder simulasi dengan kunci pemilik feed:
   `setForwarderAddress(0xB9F79d863261869B234c481D1f9A7af84AeAd192)` dan `setIdentityEnforced(false)`, jalankan simulasi
   sekali, lalu segera `setForwarderAddress(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)` dan `setIdentityEnforced(true)`.
   Selama jendela itu siapa pun bisa menulis APY ke feed testnet, jadi buka sesingkat mungkin.

**Hasil 14 Okt 2026 (penulis APY):** baca-saja dan `--broadcast` lulus. Log: `APY euler-ausd 894 bps (DefiLlama
8.94007%), feed had 893 bps` lalu `euler-ausd: wrote 894 bps, tx 0x2ce46255…caa6`. Tx sukses; log memuat `ApySet` dari
`ApyFeed` dan event forwarder simulasi; `ApyFeed.latest(sourceId Euler)` menjadi 894 bps. Forwarder dan
`identityEnforced=true` dikembalikan dalam menit yang sama (diperiksa on-chain).

**Hasil 13 Okt 2026:** log simulator menunjukkan kota dibaca, sumber Morpho terjangkau, aturan HIGH (bendera demo), lalu
`EVACUATE Satpam demo adapter 0x5Ac88e9D…1CA2 (500000021 units)` dan `Report sent. tx 0x10749bb7…cca`. Tx itu berstatus
sukses (kunci simulator ke forwarder simulasi, 450000 gas) dan menghasilkan `EvacuationRequested` di guardian; sesudahnya
adapter berisi 0 dan seluruh 1.000,000022 AUSD kota ada di idle. Konfigurasi guardian lalu dipulihkan.

**Keterbatasan:** satu eksekusi hanya membaca satu jendela `maxCities` (paling banyak 3) kota, karena kuota 15
pembacaan EVM per eksekusi. Dengan `rotate: true` (dipakai di `config.production.json`; `config.staging.json` tetap
jendela tetap supaya demo dapat diprediksi) jendelanya berpindah tiap `rotationSeconds` (samakan dengan interval cron):
`floor(waktu / rotationSeconds) mod jumlahJendela`, dengan jumlah kota dibaca dari `cityCount()` (satu pembacaan
tambahan). Hasilnya semua kota dicek sekali per siklus, misalnya 24 kota berarti 8 jendela dan satu siklus 80 menit,
jadi kota tertentu bisa tertinggal sampai 80 menit sebelum diperiksa; rotasi tidak menggantikan pemantauan terus-menerus.
Satu eksekusi dengan banyak adapter per kota masih bisa melewati kuota 15 (tiap kota memakai 2 pembacaan ditambah satu per
adapter); kuota itu belum ditegakkan di kode. Perbaikan lanjutan yang layak: temukan kota ber-Satpam lewat log
`AgentGranted` (`filterLogs`) supaya tidak membuang pembacaan pada kota tanpa Satpam.

## Temuan saat membangun (berguna untuk pengembang CRE lain)

- Objek yang melewati agregasi konsensus tidak boleh berisi angka bulat: SDK mengubahnya menjadi BigInt dan gagal
  diserialisasi. Kirim data terstruktur sebagai satu string JSON.
- Di SDK 1.23 pengaturan cache HTTP adalah `cacheSettings: { store: true, maxAge: '60s' }`, bukan `readFromCache` dan
  `maxAgeMs` seperti pada contoh dokumentasi lama. Dengan cache, hanya satu node yang benar-benar memanggil LLM dan node
  lain memakai jawabannya, sehingga konsensus identik tercapai.
- Namespace rahasia bawaan adalah `main`.
- Claude Sonnet 5.5 berpikir dulu secara default (blok `thinking`, ±280 token). Dengan `max_tokens: 300` JSON jawabannya
  terpotong dan balasan tampak tidak usable, padahal mock tes hijau. Untuk Anthropic kirim `thinking: {"type": "between_tools"}`
  (nol token berpikir, ±2 detik; `"disabled"` ditolak 400) dan beri `max_tokens` longgar. Panggilan HTTP di simulator dibatasi 10 detik.
- Kegagalan HTTP yang ditangkap bisa membuat tes hijau diam-diam; tes harus membuktikan bahwa sumber benar-benar terbaca.
- `cre generate-bindings` menghasilkan kode yang salah tipe untuk event tanpa parameter (`EIP712DomainChanged`), jadi
  ABI diringkas ke fungsi yang dipakai saja.

## Repo lain di organisasi

- [nusastakes/contracts](https://github.com/nusastakes/contracts): kontrak Solidity, termasuk `CityGuardian`
- [nusastakes/web](https://github.com/nusastakes/web): antarmuka web dan kota 3D
- [nusastakes/relayer](https://github.com/nusastakes/relayer): relayer gas dan keeper APY

## Penggunaan alat AI

Dibuat dengan Claude Code (Claude Opus untuk rencana dan pemeriksaan, Claude Sonnet 5.5 untuk pengerjaan Satpam; penulis
APY pada 14 Okt ditulis Claude Opus). Keluaran AI
diperiksa pengembang; yang belum diuji ditulis "belum diuji". LLM dalam workflow ini hanya memberi pendapat kedua dan
tidak bisa menggerakkan dana: keputusan akhir ditentukan aturan yang pasti, dan kontrak membatasi aksinya ke evakuasi
menuju idle.

## Komponen yang sudah ada sebelumnya

- [`@chainlink/cre-sdk`](https://www.npmjs.com/package/@chainlink/cre-sdk) 1.23.0, [viem](https://viem.sh) 2.34.0,
  [zod](https://zod.dev) 3.25.76, Bun, dan CLI CRE v1.38.0 (alat luar; tidak disertakan di repo).
- API GraphQL publik Morpho, dan API Anthropic atau xKiro bila kunci diisi.

## Lisensi

MIT. Lihat `LICENSE`.
