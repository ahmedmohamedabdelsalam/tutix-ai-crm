export function detectOnlinePayment(text: string): boolean {
  return /فودافون\s*كاش|إنستاباي|انستاباي|تحويل\s*بنكي|أونلاين|اونلاين|فيزا|محفظة/.test(text)
}

export function detectFarFromBranch(text: string): boolean {
  return /بعيد|مش قادر|ما\s*أقدر|مش هينفع|مش ممكن|ما\s*ينفعش|بعد عني|مش عارف أجي/.test(text)
}

export function detectVisitConfirm(text: string): boolean {
  return /تمام|هيجي|هجي|هنيجي|هنجي|موافق|طيب|أيوه|ايوه|اوكي|حاضر|هروح|هحضر|ماشي/.test(text)
}
