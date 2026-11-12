/**
 * Shared SVG <defs> for the widgets: bronze and brass gradients, a skull
 * symbol and a winged skull. Render <SigilDefs /> once inside an <svg>, then
 * reference the pieces with <use href="#skull" ... />.
 */
export function SigilDefs() {
  return (
    <defs>
      {/* Aged bronze: muted, darker than polished gold (cf. Rogue Trader's machinery trims). */}
      <linearGradient id="bronze" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="#2b1d0f" />
        <stop offset="0.28" stopColor="#6e4f2a" />
        <stop offset="0.46" stopColor="#c19a5e" />
        <stop offset="0.62" stopColor="#8a6a3a" />
        <stop offset="1" stopColor="#2b1d0f" />
      </linearGradient>
      <linearGradient id="bronze-v" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#c19a5e" />
        <stop offset="0.5" stopColor="#7a5a30" />
        <stop offset="1" stopColor="#33230f" />
      </linearGradient>
      <linearGradient id="brass" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#d9c08a" />
        <stop offset="0.45" stopColor="#9c7d42" />
        <stop offset="1" stopColor="#4a3a1a" />
      </linearGradient>
      <radialGradient id="bone" cx="0.4" cy="0.35" r="0.8">
        <stop offset="0" stopColor="#fbf3dc" />
        <stop offset="1" stopColor="#b9a983" />
      </radialGradient>
      <radialGradient id="wax" cx="0.38" cy="0.32" r="0.75">
        <stop offset="0" stopColor="#e2483f" />
        <stop offset="0.6" stopColor="#9d1a17" />
        <stop offset="1" stopColor="#5a0b0a" />
      </radialGradient>

      {/* Skull, 20 x 22 */}
      <symbol id="skull" viewBox="0 0 20 22">
        <path d="M10 1C4.8 1 1.5 4.6 1.5 9.2c0 2.8 1.2 4.6 2.8 5.6V18c0 1.6 1.2 3 2.8 3h5.8c1.6 0 2.8-1.4 2.8-3v-3.2c1.6-1 2.8-2.8 2.8-5.6C18.5 4.6 15.2 1 10 1Z" fill="url(#bone)" stroke="#3b2a14" strokeWidth="0.8" />
        <ellipse cx="6.6" cy="10" rx="2.5" ry="2.7" fill="#1b120a" />
        <ellipse cx="13.4" cy="10" rx="2.5" ry="2.7" fill="#1b120a" />
        <path d="M10 12.6 8.8 15h2.4Z" fill="#1b120a" />
        <path d="M7.2 17.2v3M9.1 17.4v3.2M10.9 17.4v3.2M12.8 17.2v3" stroke="#3b2a14" strokeWidth="0.7" />
      </symbol>

      {/* Winged skull, 60 x 24 */}
      <symbol id="winged-skull" viewBox="0 0 60 24">
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <path
              d={`M${21 - i * 1} ${8 + i * 2.6}C${15 - i * 4} ${4 + i * 3} ${7 - i * 2} ${3 + i * 3.4} ${1 + i * 1.5} ${5 + i * 3.6}C${8 - i} ${8 + i * 3} ${14 - i} ${10 + i * 2.6} ${21 - i} ${11 + i * 2.6}Z`}
              fill="url(#bronze-v)"
              stroke="#3b2a14"
              strokeWidth="0.6"
            />
            <path
              d={`M${39 + i} ${8 + i * 2.6}C${45 + i * 4} ${4 + i * 3} ${53 + i * 2} ${3 + i * 3.4} ${59 - i * 1.5} ${5 + i * 3.6}C${52 + i} ${8 + i * 3} ${46 + i} ${10 + i * 2.6} ${39 + i} ${11 + i * 2.6}Z`}
              fill="url(#bronze-v)"
              stroke="#3b2a14"
              strokeWidth="0.6"
            />
          </g>
        ))}
        <use href="#skull" x="20" y="1" width="20" height="22" />
      </symbol>

      {/* Mechanicus cog, 24 x 24 */}
      <symbol id="cog" viewBox="0 0 24 24">
        <g fill="url(#brass)" stroke="#3b2a14" strokeWidth="0.6">
          {Array.from({ length: 10 }, (_, i) => (
            <rect key={i} x="10.4" y="0.6" width="3.2" height="5" rx="0.6" transform={`rotate(${i * 36} 12 12)`} />
          ))}
          <circle cx="12" cy="12" r="8.2" />
        </g>
        <circle cx="12" cy="12" r="4.4" fill="#1b120a" />
      </symbol>
    </defs>
  );
}
