// ============================================================
// SECURITY UTILS
// ============================================================
function esc(str){
  if(str==null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Case- and accent-insensitive comparison text, e.g. "Ψαρων" and "Ψαρών" (or
// "ψαρών") both normalize to the same string — Greek tonos marks and Latin
// accents alike are stripped via Unicode decomposition, not a hand-picked
// character map.
function normalizeSearchText(str){
  return String(str||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}

