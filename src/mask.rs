//! Finds a secret's forms in output and replaces each, with the base64-alphabet run around it, with `[secret]`.
//! `claude-code/hooks/mask.ts` makes the same forms; `claude-code/tests/mask-cases.ts` holds the cases both pass.

use std::collections::BTreeSet;
use std::fmt::Write as _;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE};

pub const MASK: &[u8] = b"[secret]";
/// A stream that ends on this many bytes or more of a form's start has that tail masked.
const PARTIAL_MIN: usize = 4;
/// Past this many bytes in one run, output goes out even mid-run.
const MAX_HOLD: usize = 65536;

/// The bytes a match widens over: a base64 core's neighbours in its encoded run carry some of the value's bits, and
/// every one of them is in the standard or URL-safe alphabet. Quotes, commas, braces, `:`, `@` and whitespace end it,
/// so a value inside JSON, a URL or a header leaves the rest readable.
fn in_run(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"+/=-_".contains(&b)
}

/// JSON string escaping as Python's `json.dumps` writes it, quotes left off; `ascii` also escapes all but printable ASCII.
fn json_escaped(value: &str, ascii: bool) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if u32::from(c) < 0x20 || (ascii && !(' '..='~').contains(&c)) => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// Python's `urllib.parse.quote` over UTF-8: unreserved bytes and `safe` kept, the rest `%XX`; `plus` writes a space as `+`.
fn percent(bytes: &[u8], safe: &[u8], plus: bool) -> String {
    let mut out = String::new();
    for &b in bytes {
        if plus && b == b' ' {
            out.push('+');
        } else if b.is_ascii_alphanumeric() || b"_.~-".contains(&b) || safe.contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// The same text with every `%XX` escape in lower case.
fn lower_escapes(text: &str) -> String {
    let mut out = String::new();
    let mut after_percent = 0;
    for ch in text.chars() {
        if after_percent > 0 {
            out.push(ch.to_ascii_lowercase());
            after_percent -= 1;
        } else {
            out.push(ch);
            if ch == '%' {
                after_percent = 2;
            }
        }
    }
    out
}

fn hex(bytes: &[u8], upper: bool) -> String {
    let mut out = String::new();
    for b in bytes {
        let _ = if upper { write!(out, "{b:02X}") } else { write!(out, "{b:02x}") };
    }
    out
}

/// The ways `value` turns up in output: raw, escaped, percent-, hex- and base64-encoded.
pub fn forms(value: &str) -> BTreeSet<Vec<u8>> {
    let raw = value.as_bytes();
    let mut texts = vec![
        value.to_owned(),
        json_escaped(value, false),
        json_escaped(value, true),
        value.replace('\'', "'\\''"),
        value.replace('\'', "'\"'\"'"),
        hex(raw, false),
        hex(raw, true),
    ];
    for encoded in [percent(raw, b"", false), percent(raw, b"!~*'()", false), percent(raw, b"", true)] {
        texts.push(lower_escapes(&encoded));
        texts.push(encoded);
    }
    let mut found: BTreeSet<Vec<u8>> = texts.into_iter().map(String::into_bytes).collect();
    for engine in [STANDARD, URL_SAFE] {
        for offset in 0..3 {
            // The characters fully determined by the value's bits, wherever it sits in the encoded run.
            let mut padded = vec![0u8; offset];
            padded.extend_from_slice(raw);
            padded.extend_from_slice(&[0, 0, 0]);
            let encoded = engine.encode(&padded);
            let core = encoded.get((8 * offset).div_ceil(6)..(8 * (offset + raw.len())) / 6).unwrap_or_default();
            found.insert(core.as_bytes().to_vec());
        }
    }
    found.remove(&Vec::new());
    found
}

/// `data` with each span replaced by `MASK`, and whether there was any.
fn masked(data: &[u8], spans: &[(usize, usize)]) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(data.len());
    let mut at = 0;
    for &(start, end) in spans {
        out.extend_from_slice(data.get(at..start).unwrap_or_default());
        out.extend_from_slice(MASK);
        at = end;
    }
    out.extend_from_slice(data.get(at..).unwrap_or_default());
    (out, !spans.is_empty())
}

pub struct Masker {
    min_length: usize,
    patterns: BTreeSet<Vec<u8>>,
}

impl Drop for Masker {
    fn drop(&mut self) {
        for mut pattern in std::mem::take(&mut self.patterns) {
            zeroize::Zeroize::zeroize(&mut pattern);
        }
    }
}

impl Masker {
    /// Values shorter than `min_length` characters are left unmasked: they would turn up in ordinary text.
    pub fn new(min_length: usize) -> Self {
        Self { min_length, patterns: BTreeSet::new() }
    }

    pub fn add(&mut self, value: &str) {
        if value.chars().count() >= self.min_length {
            self.patterns.extend(forms(value));
        }
    }

    /// Adds `value` whatever its length: one known to be in this output, as the value a call was handed is in its own.
    pub fn add_any_length(&mut self, value: &str) {
        self.patterns.extend(forms(value));
    }

    /// Each form with its run around it, as merged `(start, end)` ranges.
    pub fn spans(&self, data: &[u8]) -> Vec<(usize, usize)> {
        let opens = |at: usize| data.get(at).is_some_and(|b| in_run(*b));
        let mut found = Vec::new();
        for pattern in &self.patterns {
            for at in memchr::memmem::find_iter(data, pattern) {
                let mut start = at;
                let mut end = at + pattern.len();
                while start > 0 && opens(start - 1) {
                    start -= 1;
                }
                while opens(end) {
                    end += 1;
                }
                found.push((start, end));
            }
        }
        found.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in found {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        merged
    }

    pub fn mask(&self, data: &[u8]) -> Vec<u8> {
        self.mask_found(data).0
    }

    /// The masked data, and whether anything in it was masked.
    pub fn mask_found(&self, data: &[u8]) -> (Vec<u8>, bool) {
        masked(data, &self.spans(data))
    }

    /// `mask_found` for the last of a stream: a tail of `PARTIAL_MIN` bytes or more that a form starts with is masked
    /// too, with the rest of its run, since nothing more will come to tell it apart.
    pub fn mask_end(&self, data: &[u8]) -> (Vec<u8>, bool) {
        let mut spans = self.spans(data);
        let tail = self.partial(data);
        if tail >= PARTIAL_MIN {
            let start = data.len() - tail;
            let token = data.get(..start).unwrap_or_default().iter().rposition(|b| !in_run(*b)).map_or(0, |at| at + 1);
            // a form holding bytes outside the run can reach into the tail's run
            let from = spans.iter().filter(|&&(_, end)| end > token).map(|&(start, _)| start).fold(token, usize::min);
            spans.retain(|&(_, end)| end <= from);
            spans.push((from, data.len()));
        }
        masked(data, &spans)
    }

    /// How many trailing bytes could still grow into a form.
    pub fn partial(&self, data: &[u8]) -> usize {
        let mut longest = 0;
        for pattern in &self.patterns {
            let most = (pattern.len() - 1).min(data.len());
            for size in (longest + 1..=most).rev() {
                if data.get(data.len() - size..).is_some_and(|tail| pattern.starts_with(tail)) {
                    longest = size;
                    break;
                }
            }
        }
        longest
    }

    /// How much of `data` can be masked and written now; the rest may still grow into a run holding a form.
    /// Idle, only a tail that could become a form is kept back.
    pub fn cut(&self, data: &[u8], idle: bool) -> usize {
        if self.patterns.is_empty() {
            return data.len();
        }
        let mut cut = data.len() - self.partial(data);
        if !idle {
            let token_start = data.iter().rposition(|b| !in_run(*b)).map_or(0, |at| at + 1);
            cut = cut.min(token_start);
            if data.len() - cut > MAX_HOLD {
                let longest = self.patterns.iter().map(Vec::len).max().unwrap_or(0);
                cut = data.len().saturating_sub(longest);
            }
        }
        for (start, end) in self.spans(data) {
            if start < cut && cut < end {
                cut = start;
            }
        }
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        values: Vec<String>,
        min: usize,
        input: String,
        output: String,
    }

    fn shared_cases() -> Vec<Case> {
        let source = include_str!("../claude-code/tests/mask-cases.ts");
        let start = "\nexport default";
        let json = &source[source.find(start).unwrap() + start.len()..];
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn the_shared_cases_mask_as_the_hooks_do() {
        for case in shared_cases() {
            let mut masker = Masker::new(case.min);
            for value in &case.values {
                masker.add(value);
            }
            let result = String::from_utf8(masker.mask(case.input.as_bytes())).unwrap();
            assert_eq!(result, case.output, "input {:?}", case.input);
        }
    }

    #[test]
    fn a_tail_that_could_become_a_value_is_kept_back_idle_too() {
        let mut masker = Masker::new(6);
        masker.add("hunter2");
        assert_eq!(masker.cut(b"done\nhun", true), 5);
        assert_eq!(masker.cut(b"done\nhunt", false), 5);
        assert_eq!(masker.cut(b"done\nplain", true), 10);
    }

    #[test]
    fn output_without_whitespace_waits_for_a_whole_token() {
        let mut masker = Masker::new(6);
        masker.add("hunter2");
        assert_eq!(masker.cut(b"first second", false), 6);
        assert_eq!(masker.cut(b"first second", true), 12);
    }

    #[test]
    fn with_nothing_to_mask_everything_goes_out_at_once() {
        assert_eq!(Masker::new(6).cut(b"first sec", false), 9);
    }

    const VALUES: [&str; 7] = ["hunter22", "p@ss w0rd!", "a\"b\\c-123", "it's-secret", "ключик-42", "tok_9f-8E+/=", "50%off&more"];
    /// Every byte that ends a run, as output frames values: quoting, JSON, URLs, headers, shell, whitespace.
    const DELIMITERS: [&str; 24] =
        ["\"", "'", "`", ",", ":", ";", "@", "&", "?", "#", "|", "!", "*", "(", ")", "[", "]", "{", "}", "<", ">", " ", "\t", "\n"];

    fn masker_of(value: &str) -> Masker {
        let mut masker = Masker::new(6);
        masker.add(value);
        masker
    }

    /// What a stream cut into `chunks` comes out as, frame by frame as the relay masks it, the last frame ending it.
    fn streamed(masker: &Masker, chunks: &[&[u8]]) -> Vec<u8> {
        let mut held = Vec::new();
        let mut out = Vec::new();
        let Some((last, before)) = chunks.split_last() else { return out };
        for chunk in before {
            held.extend_from_slice(chunk);
            let cut = masker.cut(&held, false);
            out.extend(masker.mask(&held[..cut]));
            held.drain(..cut);
        }
        held.extend_from_slice(last);
        out.extend(masker.mask_end(&held).0);
        out
    }

    /// Every way of cutting `data` in two, and byte by byte, comes out as the whole of it does.
    fn assert_streams_as_whole(masker: &Masker, data: &[u8]) {
        let whole = masker.mask_end(data).0;
        for at in 0..=data.len() {
            let (head, tail) = data.split_at(at);
            assert_eq!(streamed(masker, &[head, tail]), whole, "{:?} cut at {at}", String::from_utf8_lossy(data));
        }
        let bytes: Vec<&[u8]> = data.chunks(1).collect();
        assert_eq!(streamed(masker, &bytes), whole, "{:?} byte by byte", String::from_utf8_lossy(data));
    }

    #[test]
    fn each_form_between_delimiters_is_masked_alone_and_the_delimiters_stay() {
        for value in VALUES {
            let masker = masker_of(value);
            for form in forms(value) {
                let form = String::from_utf8(form).unwrap();
                for d in DELIMITERS {
                    let input = format!("k{d}{form}{d}k");
                    assert_eq!(String::from_utf8(masker.mask(input.as_bytes())).unwrap(), format!("k{d}[secret]{d}k"), "{value:?} as {form:?}");
                    assert_streams_as_whole(&masker, input.as_bytes());
                }
            }
        }
    }

    #[test]
    fn a_form_glued_to_run_bytes_takes_the_run_with_it() {
        for value in ["hunter22", "tok_9f-8E+/="] {
            let masker = masker_of(value);
            for (glued, d) in [("pw=", ";"), ("x-", ","), ("Bearer+", "\""), ("ab/", "@")] {
                let input = format!("{d}{glued}{value}{glued}{d}");
                assert_eq!(String::from_utf8(masker.mask(input.as_bytes())).unwrap(), format!("{d}[secret]{d}"), "{value:?} in {input:?}");
            }
        }
    }

    #[test]
    fn a_base64_run_holding_the_value_is_masked_whole_at_every_offset() {
        use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
        for value in VALUES {
            let masker = masker_of(value);
            for engine in [STANDARD, URL_SAFE, STANDARD_NO_PAD, URL_SAFE_NO_PAD] {
                for prefix in ["", "u", "us", "use", "user", "user:"] {
                    for suffix in ["", "\n", "@h", "xyz"] {
                        let encoded = engine.encode(format!("{prefix}{value}{suffix}"));
                        for d in DELIMITERS {
                            let input = format!("x{d}{encoded}{d}x");
                            assert_eq!(
                                String::from_utf8(masker.mask(input.as_bytes())).unwrap(),
                                format!("x{d}[secret]{d}x"),
                                "{value:?} behind {prefix:?} encoded {encoded:?}"
                            );
                        }
                        assert_streams_as_whole(&masker, format!("auth: {encoded}, next").as_bytes());
                    }
                }
            }
        }
    }

    #[test]
    fn values_side_by_side_are_masked_each_and_what_is_between_them_stays() {
        let mut masker = Masker::new(6);
        masker.add("hunter22");
        masker.add("tok_9f-8E+/=");
        let input = r#"{"a":"hunter22","b":"tok_9f-8E+/="} hunter22,tok_9f-8E+/="#;
        assert_eq!(String::from_utf8(masker.mask(input.as_bytes())).unwrap(), r#"{"a":"[secret]","b":"[secret]"} [secret],[secret]"#);
        assert_streams_as_whole(&masker, input.as_bytes());
    }
}
