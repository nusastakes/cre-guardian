# nusastakes/cre-guardian

Workflow Chainlink CRE **"City Guardian"** (peran Satpam) untuk **Nusastakes**.

> **Status: rencana, belum ada kode** (backlog B3.2, bounty B11). Repo ini dipublikasikan lebih awal supaya riwayat
> commit hackathon terlihat. Sisi kontrak (`CityGuardian`) sudah ada dan diuji di
> [nusastakes/contracts](https://github.com/nusastakes/contracts).

## Tujuan

Memantau kota dan, bila risiko di atas ambang, melaporkan ke `CityGuardian` agar dana dievakuasi dari adapter ke idle.
Evakuasi hanya berlaku bila walikota kota itu sudah mengaktifkan Satpam CRE (`grantAgent(city, CRE_SATPAM, SATPAM, expiry)`).

## Rencana

1. Pemicu: cron tiap 10 menit, ditambah event `Rebalanced` dan `Deposit` dari vault.
2. Baca fee dan yield dari DefiLlama (HTTP), lalu saldo vault dan adapter (EVM read).
3. Panggil LLM untuk mengklasifikasi risiko dan menyusun alasan, dengan output terstruktur.
4. Tulis laporan ke `CityGuardian` lewat forwarder CRE. Muatan (ABI-encode, tuple datar):
   `(address target, address city, uint8 action, address adapter, bytes32 planHash, uint64 chainSelector, uint256 scheduledAt)`.
   `target` harus sama dengan alamat `CityGuardian`, `chainSelector` Monad testnet adalah `2183018362218727504`, dan
   `scheduledAt` (detik) harus naik untuk setiap pasangan kota+adapter dan tidak boleh lebih dari 1 jam di depan jam rantai.
5. Opsional (fase 3): menulis APY ke `ApyFeed` dengan muatan `(address target, bytes32 sourceId, uint32 apyBps, uint64 observedAt, uint64 chainSelector)`.

## Batas yang diketahui

- Runtime QuickJS tanpa Node API; maksimal 15 HTTP call dan 15 EVM read per run.
- LLM hanya mengusulkan. Dana bergerak otomatis hanya lewat aturan deterministik di kontrak: adapter yang diizinkan,
  batas pergeseran, dan evakuasi hanya ke idle.
- Forwarder simulasi (`MockKeystoneForwarder`) tidak memverifikasi tanda tangan; kontrak menolak laporan sampai
  pemilik mengunci identitas workflow (`expectedAuthor` atau `expectedWorkflowId`).

## Belum diuji

Forwarder CRE sungguhan menulis ke kontrak kita di Monad testnet belum pernah diuji siapa pun (butuh akun CRE dan CLI).

## Repo lain di organisasi

- [nusastakes/contracts](https://github.com/nusastakes/contracts): kontrak Solidity
- [nusastakes/web](https://github.com/nusastakes/web): antarmuka web dan kota 3D
- [nusastakes/relayer](https://github.com/nusastakes/relayer): relayer gas dan keeper APY

## Penggunaan alat AI

Dibuat dengan Claude Code (Claude Opus untuk rencana dan pemeriksaan, Claude Sonnet untuk pengerjaan). Keluaran AI
diperiksa pengembang; yang belum diuji ditulis "belum diuji". LLM dalam workflow ini hanya mengusulkan; ia tidak pernah
memindahkan dana.

## Komponen yang sudah ada sebelumnya

Belum ada dependensi. Rencana: Chainlink CRE SDK dan CLI (versi minimum untuk Monad testnet: CLI v1.30.0, TS SDK v1.19.0).

## Lisensi

MIT. Lihat `LICENSE`.
