# nusastakes/cre-guardian

Workflow Chainlink CRE **"City Guardian"** (peran Satpam) untuk **Nusastakes**: memantau kota (vault ERC-4626) dan,
bila risikonya tinggi, meminta kontrak `CityGuardian` menarik dana kota dari adapter kembali ke idle.

> **Status:** kode workflow, tes, dan binding kontrak sudah ada dan lulus (47 tes bun). **Belum pernah dijalankan di
> simulator CRE sungguhan**, karena CLI CRE mewajibkan login akun (`cre login`) bahkan untuk simulasi. Forwarder CRE
> yang menulis ke `CityGuardian` di Monad testnet juga belum diuji. Langkah menjalankannya ada di bagian "Simulasi".

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
| `city-guardian/*.test.ts` | 47 tes (`bun test`) |
| `city-guardian/config.{staging,production}.json` | Parameter: jadwal, alamat kontrak, ambang, provider LLM |
| `contracts/evm/src/abi/` | ABI ringkas (hanya fungsi yang dipakai workflow) dari repo `contracts` |
| `contracts/evm/ts/generated/` | Binding TypeScript hasil `cre generate-bindings evm` |
| `project.yaml`, `secrets.yaml` | RPC per target dan daftar nama rahasia |

## Konfigurasi

`city-guardian/config.staging.json` (ambang dalam basis poin; `maxCities` paling banyak 3 supaya tetap di bawah kuota
15 pembacaan EVM per eksekusi):

```json
{
  "schedule": "0 */10 * * * *",
  "chainSelectorName": "monad-testnet",
  "factoryAddress": "0x6765F0C80F6a7D5EC7Af120d12e81628F641508E",
  "guardianAddress": "0x083899bEE8138E5f951db568926393FDb1F418A2",
  "maxCities": 3,
  "thresholds": { "drawdownHighBps": 200, "drawdownMediumBps": 50, "apyOutlierPct": 25 },
  "llm": { "provider": "anthropic", "model": "claude-sonnet-5-5", "maxTokens": 300 },
  "source": { "morphoApi": "https://blue-api.morpho.org/graphql", "vault": "0x32841A8511D5c2c5b253f45668780B99139e476D", "chainId": 143 },
  "gasLimit": "450000"
}
```

**LLM.** `provider` bisa `anthropic` (`https://api.anthropic.com/v1/messages`, model `claude-sonnet-5-5`), `xkiro`
(gateway yang kompatibel dengan format Anthropic dan OpenAI di `https://api.xkiro.com/v1/messages`; ID model memakai
awalan vendor dan diambil dari `GET /v1/models`, bukan ditebak), atau `none` (hanya aturan). Kuncinya `ANTHROPIC_API_KEY`
atau `XKIRO_API_KEY`, dibaca lewat rahasia CRE, tidak pernah ditaruh di konfigurasi atau repo. Tanpa kunci, workflow
tetap jalan hanya dengan aturan. Catatan: pada HTTP biasa kunci terlihat oleh node yang memanggil; untuk produksi
sungguhan pakai Confidential HTTP.

**Demo.** `demoForceHighCity` (alamat vault) memaksa risiko HIGH untuk satu kota supaya evakuasi bisa ditunjukkan di
video; kosongkan di luar demo.

## Menjalankan tes

```
export PATH="$HOME/.cre/bin:$HOME/.cre/tools:$PATH"     # lokasi CLI dan Bun bila dipasang manual
cd city-guardian && bun install
bun run typecheck
bun test
```

Tes memakai mock resmi SDK untuk EVM, HTTP, dan rahasia, dan mencakup: aturan risiko, penggabungan LLM (LLM tidak bisa
membuat atau menurunkan risiko), kedua provider, kegagalan LLM, kunci yang tidak boleh bocor ke prompt, kota yang
belum mengaktifkan Satpam, adapter kosong, transaksi laporan gagal, dan muatan laporan yang cocok persis dengan
`CityGuardian` di Solidity (ada juga fixture lintas bahasa di `contracts/test/CityGuardian.t.sol`).

## Simulasi (butuh akun CRE)

1. Buat akun di https://app.chain.link/cre/discover (dengan 2FA), lalu `cre login`.
2. Isi `.env` dari `.env.example`: `CRE_ETH_PRIVATE_KEY` (kunci testnet khusus simulator, butuh sedikit MON bila memakai
   `--broadcast`) dan kunci LLM bila ingin pendapat kedua.
3. Simulasi baca-saja: `cre workflow simulate city-guardian --target staging-settings --non-interactive --trigger-index 0`.
4. Untuk menulis laporan sungguhan ke Monad testnet (`--broadcast`), pemilik `CityGuardian` harus lebih dulu mengganti
   forwarder ke forwarder simulasi `0xB9F79d863261869B234c481D1f9A7af84AeAd192` (`setForwarderAddress`) dan mematikan
   penguncian identitas sementara (`setIdentityEnforced(false)`), lalu walikota kota demo memberi peran Satpam ke
   `CRE_SATPAM()` (`grantAgent`). Setelah demo, kembalikan keduanya. Dokumentasi Chainlink saling bertentangan tentang
   apakah simulasi benar-benar memanggil `onReport`, jadi ini perlu dibuktikan dengan `--broadcast`.

## Temuan saat membangun (berguna untuk pengembang CRE lain)

- Objek yang melewati agregasi konsensus tidak boleh berisi angka bulat: SDK mengubahnya menjadi BigInt dan gagal
  diserialisasi. Kirim data terstruktur sebagai satu string JSON.
- Di SDK 1.23 pengaturan cache HTTP adalah `cacheSettings: { store: true, maxAge: '60s' }`, bukan `readFromCache` dan
  `maxAgeMs` seperti pada contoh dokumentasi lama. Dengan cache, hanya satu node yang benar-benar memanggil LLM dan node
  lain memakai jawabannya, sehingga konsensus identik tercapai.
- Namespace rahasia bawaan adalah `main`.
- Kegagalan HTTP yang ditangkap bisa membuat tes hijau diam-diam; tes harus membuktikan bahwa sumber benar-benar terbaca.
- `cre generate-bindings` menghasilkan kode yang salah tipe untuk event tanpa parameter (`EIP712DomainChanged`), jadi
  ABI diringkas ke fungsi yang dipakai saja.

## Repo lain di organisasi

- [nusastakes/contracts](https://github.com/nusastakes/contracts): kontrak Solidity, termasuk `CityGuardian`
- [nusastakes/web](https://github.com/nusastakes/web): antarmuka web dan kota 3D
- [nusastakes/relayer](https://github.com/nusastakes/relayer): relayer gas dan keeper APY

## Penggunaan alat AI

Dibuat dengan Claude Code (Claude Opus untuk rencana dan pemeriksaan, Claude Sonnet 5.5 untuk pengerjaan). Keluaran AI
diperiksa pengembang; yang belum diuji ditulis "belum diuji". LLM dalam workflow ini hanya memberi pendapat kedua dan
tidak bisa menggerakkan dana: keputusan akhir ditentukan aturan yang pasti, dan kontrak membatasi aksinya ke evakuasi
menuju idle.

## Komponen yang sudah ada sebelumnya

- [`@chainlink/cre-sdk`](https://www.npmjs.com/package/@chainlink/cre-sdk) 1.23.0, [viem](https://viem.sh) 2.34.0,
  [zod](https://zod.dev) 3.25.76, Bun, dan CLI CRE v1.38.0 (alat luar; tidak disertakan di repo).
- API GraphQL publik Morpho, dan API Anthropic atau xKiro bila kunci diisi.

## Lisensi

MIT. Lihat `LICENSE`.
