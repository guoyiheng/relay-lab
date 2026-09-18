import { describe, expect, it } from 'vitest'
import { detectTriggerToken } from '../shared/prompt-trigger'

describe('detectTriggerToken', () => {
  describe('Slash trigger for favorites (/)', () => {
    it('triggers at start of input', () => {
      const res = detectTriggerToken('/')
      expect(res).toEqual({ type: 'fav', query: '', tokenLen: 1 })
    })

    it('triggers at start of input with query', () => {
      const res = detectTriggerToken('/cat')
      expect(res).toEqual({ type: 'fav', query: 'cat', tokenLen: 4 })
    })

    it('triggers with Chinese query', () => {
      const res = detectTriggerToken('/猫咪')
      expect(res).toEqual({ type: 'fav', query: '猫咪', tokenLen: 3 })
    })

    it('triggers after whitespace', () => {
      const res = detectTriggerToken('A cute cat /anime')
      expect(res).toEqual({ type: 'fav', query: 'anime', tokenLen: 6 })
    })

    it('triggers after newline', () => {
      const res = detectTriggerToken('Line 1\n/fav')
      expect(res).toEqual({ type: 'fav', query: 'fav', tokenLen: 4 })
    })

    it('does NOT trigger inside full prompt with Chinese punctuation and slash', () => {
      const fullPrompt = '参考@图片1的人物和场景、参考@音频1的音色。15秒，9:16竖屏，24fps，正面中近景，一镜到底，人物始终居中。三组“中文→停顿0.4秒→日语”：中文“不行……/不要……”时双手夸张比×鼓起脸，日语“ダメ…”时食指快速左右摆并俏皮眨眼；中文“请停下来/请别这样”时双手合十上下拜托，日语“やめてください”时歪头做请求手势；中文“会被人看见的”时夸张探头张望，日语“誰かに見られちゃう”时手指唇边快速回头。动作夸张俏皮、有回弹，日语慵懒成熟、包裹感强，中文清晰自然，口型同步。禁止字幕、文字、贴纸、LOGO、水印及AI伪影。'
      expect(detectTriggerToken(fullPrompt)).toBeNull()
    })

    it('does NOT trigger inside Chinese word/alternative like 不行/不要', () => {
      expect(detectTriggerToken('不行/不要')).toBeNull()
      expect(detectTriggerToken('是/否')).toBeNull()
      expect(detectTriggerToken('男/女')).toBeNull()
    })

    it('does NOT trigger inside URLs', () => {
      expect(detectTriggerToken('https://cdn.example.com/images/cat.png')).toBeNull()
      expect(detectTriggerToken('http://localhost:3000/api/tasks')).toBeNull()
    })

    it('does NOT trigger inside ratios or numbers', () => {
      expect(detectTriggerToken('16/9')).toBeNull()
      expect(detectTriggerToken('9/16')).toBeNull()
      expect(detectTriggerToken('1/2')).toBeNull()
    })

    it('does NOT trigger inside English words', () => {
      expect(detectTriggerToken('and/or')).toBeNull()
      expect(detectTriggerToken('fast/slow')).toBeNull()
      expect(detectTriggerToken('s/he')).toBeNull()
    })

    it('closes when sentence punctuation is entered after query', () => {
      expect(detectTriggerToken('/cat,')).toBeNull()
      expect(detectTriggerToken('/cat，')).toBeNull()
      expect(detectTriggerToken('/cat。')).toBeNull()
      expect(detectTriggerToken('/cat;')).toBeNull()
    })
  })

  describe('At trigger for reference assets (@)', () => {
    it('triggers at start of input', () => {
      const res = detectTriggerToken('@')
      expect(res).toEqual({ type: 'asset', query: '', tokenLen: 1 })
    })

    it('triggers at start with query', () => {
      const res = detectTriggerToken('@cat')
      expect(res).toEqual({ type: 'asset', query: 'cat', tokenLen: 4 })
    })

    it('triggers after whitespace with file extension', () => {
      const res = detectTriggerToken('A cute cat @cat.png')
      expect(res).toEqual({ type: 'asset', query: 'cat.png', tokenLen: 8 })
    })

    it('triggers directly after Chinese text', () => {
      const res = detectTriggerToken('参考@图片1')
      expect(res).toEqual({ type: 'asset', query: '图片1', tokenLen: 4 })
    })

    it('triggers after Chinese punctuation', () => {
      const res = detectTriggerToken('、@音频1')
      expect(res).toEqual({ type: 'asset', query: '音频1', tokenLen: 4 })
    })

    it('does NOT trigger for email addresses', () => {
      expect(detectTriggerToken('test@example.com')).toBeNull()
      expect(detectTriggerToken('user_name@domain.org')).toBeNull()
    })

    it('does NOT trigger when allowAssets is false', () => {
      expect(detectTriggerToken('@cat', false)).toBeNull()
    })

    it('closes when sentence punctuation follows the query', () => {
      expect(detectTriggerToken('参考@图片1，人物始终居中')).toBeNull()
    })
  })
})
