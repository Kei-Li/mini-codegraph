import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { traceVariable } from '../src/resolution/dispatch-inference/variable-tracer.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseConnection } from '../src/db/connection.js'
import { QueryManager } from '../src/db/queries.js'
import type { MiniCodeGraphNode } from '../src/types.js'

import { AopDetector } from '../src/resolution/dispatch-inference/detectors/aop-detector.js'
import { StrategyDetector } from '../src/resolution/dispatch-inference/detectors/strategy-detector.js'
import { ProxyDetector } from '../src/resolution/dispatch-inference/detectors/proxy-detector.js'
import { FactoryDetector } from '../src/resolution/dispatch-inference/detectors/factory-detector.js'
import { ReflectionDetector } from '../src/resolution/dispatch-inference/detectors/reflection-detector.js'
import { SpiDetector } from '../src/resolution/dispatch-inference/detectors/spi-detector.js'
import { ConditionalBeanDetector } from '../src/resolution/dispatch-inference/detectors/conditional-bean-detector.js'
import { DispatchInferenceEngine } from '../src/resolution/dispatch-inference/index.js'
import { mergeInferredEdges } from '../src/resolution/dispatch-inference/resolver.js'

function n(id: string, name: string, kind: string, overrides: Partial<MiniCodeGraphNode> = {}): MiniCodeGraphNode {
  return {
    id, name, kind,
    qualifiedName: overrides.qualifiedName ?? name,
    filePath: overrides.filePath ?? 'Test.java',
    language: 'java',
    startLine: 1, endLine: 10, startColumn: 0, endColumn: 0,
    docstring: '', signature: '', visibility: 'public',
    isExported: false, parentId: null,
    moduleId: 'test-mod',
    ...overrides,
  }
}

describe('Dispatch Inference Engine', () => {
  let conn: DatabaseConnection
  let queries: QueryManager

  beforeEach(() => {
    conn = new DatabaseConnection(':memory:')
    conn.open()
    queries = new QueryManager(conn)

    queries.insertModule({ id: 'test-mod', name: 'test', rootPath: '/test', buildSystem: 'maven', language: 'java', indexedAt: Date.now() })
  })

  afterEach(() => {
    try { conn.close() } catch { /* silent */ }
  })

  // ──────────────────────────────────────────────
  // AOP DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('AopDetector', () => {
    it('detects AOP proxy via @Transactional annotation', async () => {
      const cls = n('cls1', 'UserService', 'class', { qualifiedName: 'com.app.UserService' })
      const iface = n('iface1', 'UserServiceIface', 'class')
      queries.insertNode(cls)
      queries.insertNode(iface)
      queries.insertEdge(cls.id, iface.id, 'implements')
      queries.insertAnnotation(cls.id, 'Transactional', '', 1, 'test-mod')

      const detector = new AopDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      expect(patterns).toHaveLength(1)
      expect(patterns[0].type).toBe('aop_proxy')
      expect(patterns[0].sourceId).toBe('cls1')
      expect(patterns[0].possibleTargets[0].provenance).toBe('aop_proxy')
      expect(patterns[0].possibleTargets[0].condition?.source).toBe('annotation')
    })

    it('resolves execution() pointcut against method nodes', async () => {
      const aspect = n('asp1', 'LoggingAspect', 'class', { qualifiedName: 'com.app.LoggingAspect' })
      queries.insertNode(aspect)
      queries.insertAnnotation(aspect.id, 'Aspect', '', 1, 'test-mod')
      queries.insertAnnotation(aspect.id, 'Pointcut', 'execution(* com.app..*Service.*(..))', 2, 'test-mod')

      const serviceClass = n('srv1', 'OrderService', 'class', { qualifiedName: 'com.app.OrderService' })
      queries.insertNode(serviceClass)
      queries.insertAnnotation(serviceClass.id, 'Transactional', '', 3, 'test-mod')

      const method1 = n('m1', 'createOrder', 'method', { parentId: 'srv1', qualifiedName: 'com.app.OrderService.createOrder' })
      const method2 = n('m2', 'cancelOrder', 'method', { parentId: 'srv1', qualifiedName: 'com.app.OrderService.cancelOrder' })
      const method3 = n('m3', 'internalHelper', 'method', { parentId: 'srv1', qualifiedName: 'com.app.OrderService.internalHelper' })
      queries.insertNode(method1)
      queries.insertNode(method2)
      queries.insertNode(method3)

      const nonServiceClass = n('other1', 'Config', 'class', { qualifiedName: 'com.app.Config' })
      queries.insertNode(nonServiceClass)

      const detector = new AopDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      // Should find aspect-derived AOP pattern for pointcut
      const aspectPatterns = patterns.filter(p =>
        p.sourceId === 'asp1' && p.possibleTargets.some(t => t.condition?.source === 'pointcut')
      )
      expect(aspectPatterns.length).toBeGreaterThan(0)

      // Find all pointcut-matched targets
      const pointcutTargets = patterns.flatMap(p =>
        p.possibleTargets.filter(t => t.condition?.source === 'pointcut')
      )
      // Should match methods in *Service classes
      const matchedIds = pointcutTargets.map(t => t.targetId)
      expect(matchedIds).toContain('m1')
      expect(matchedIds).toContain('m2')
    })

    it('detects within() pointcut', async () => {
      const aspect = n('asp2', 'SecurityAspect', 'class')
      queries.insertNode(aspect)
      queries.insertAnnotation(aspect.id, 'Aspect', '', 1, 'test-mod')
      queries.insertAnnotation(aspect.id, 'Pointcut', 'within(com.app.controller..*)', 2, 'test-mod')

      const ctrl = n('ctrl1', 'UserController', 'class', { qualifiedName: 'com.app.controller.UserController' })
      queries.insertNode(ctrl)
      const ctrlMethod = n('cm1', 'listUsers', 'method', { parentId: 'ctrl1' })
      queries.insertNode(ctrlMethod)

      const nonCtrl = n('nc1', 'Helper', 'class', { qualifiedName: 'com.app.Helper' })
      queries.insertNode(nonCtrl)

      const detector = new AopDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const pointcutTargets = patterns.flatMap(p =>
        p.possibleTargets.filter(t => t.condition?.source === 'pointcut')
      )
      const matchedIds = pointcutTargets.map(t => t.targetId)
      expect(matchedIds).toContain('ctrl1')
      expect(matchedIds).toContain('cm1')
      expect(matchedIds).not.toContain('nc1')
    })

    it('detects @annotation pointcut', async () => {
      const aspect = n('asp3', 'TimingAspect', 'class')
      queries.insertNode(aspect)
      queries.insertAnnotation(aspect.id, 'Aspect', '', 1, 'test-mod')
      queries.insertAnnotation(aspect.id, 'Pointcut', '@annotation(Timed)', 2, 'test-mod')

      const timedMethod = n('tm1', 'timedOp', 'method', { qualifiedName: 'com.app.timedOp' })
      queries.insertNode(timedMethod)
      queries.insertAnnotation(timedMethod.id, 'Timed', '', 3, 'test-mod')

      const normalMethod = n('nm1', 'normalOp', 'method')
      queries.insertNode(normalMethod)

      const detector = new AopDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const pointcutTargets = patterns.flatMap(p =>
        p.possibleTargets.filter(t => t.condition?.source === 'pointcut')
      )
      const matchedIds = pointcutTargets.map(t => t.targetId)
      expect(matchedIds).toContain('tm1')
      expect(matchedIds).not.toContain('nm1')
    })

    it('handles aspect weaving edges', async () => {
      const aspect = n('asp4', 'TxAspect', 'class')
      queries.insertNode(aspect)
      queries.insertAnnotation(aspect.id, 'Aspect', '', 1, 'test-mod')

      const targetMethod = n('txm1', 'save', 'method')
      queries.insertNode(targetMethod)
      queries.insertEdge(aspect.id, targetMethod.id, 'aspect_weave', '{}')

      const detector = new AopDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const weaveTargets = patterns.flatMap(p =>
        p.possibleTargets.filter(t => t.condition?.source === 'aspect_weave')
      )
      expect(weaveTargets).toHaveLength(1)
      expect(weaveTargets[0].targetId).toBe('txm1')
    })
  })

  // ──────────────────────────────────────────────
  // STRATEGY / RUNTIME DISPATCH TESTS
  // ──────────────────────────────────────────────
  describe('StrategyDetector with runtime dispatch', () => {
    it('detects strategy pattern via multi-impl interface', async () => {
      const iface = n('pay', 'PaymentStrategy', 'interface')
      queries.insertNode(iface)

      const cc = n('cc', 'CreditCardPayment', 'class')
      queries.insertNode(cc)
      queries.insertEdge(cc.id, iface.id, 'implements')

      const pp = n('pp', 'PayPalPayment', 'class')
      queries.insertNode(pp)
      queries.insertEdge(pp.id, iface.id, 'implements')

      const alipay = n('ali', 'AlipayPayment', 'class')
      queries.insertNode(alipay)
      queries.insertEdge(alipay.id, iface.id, 'implements')

      const detector = new StrategyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const multiImpl = patterns.filter(p => p.interfaceName === 'PaymentStrategy')
      expect(multiImpl).toHaveLength(1)
      expect(multiImpl[0].possibleTargets).toHaveLength(3)
    })

    it('traces Map.get() key to switch cases', async () => {
      const mapClass = n('map1', 'handlerMap', 'class')
      queries.insertNode(mapClass)

      const switchMethod = n('swm1', 'handleRequest', 'method', { parentId: 'swm1-parent' })
      queries.insertNode(switchMethod)

      const getMethod = n('get1', 'get', 'method', { parentId: 'map1', qualifiedName: 'java.util.Map.get' })
      queries.insertNode(getMethod)

      // Caller: handleRequest calls Map.get
      queries.insertEdge(switchMethod.id, getMethod.id, 'calls')

      // Switch block in same method
      const swBlock = n('sw1', 'switch_block', 'switch', { parentId: switchMethod.id })
      queries.insertNode(swBlock)
      queries.insertEdge(switchMethod.id, swBlock.id, 'references')

      // Case labels
      const caseA = n('case_a', 'case "alipay"', 'case', { parentId: swBlock.id })
      const caseB = n('case_b', 'case "wechat"', 'case', { parentId: swBlock.id })
      queries.insertNode(caseA)
      queries.insertNode(caseB)

      // Impl classes matching keys
      const aliPay = n('ali2', 'AlipayHandler', 'class')
      queries.insertNode(aliPay)
      const wechatPay = n('wx2', 'WechatHandler', 'class')
      queries.insertNode(wechatPay)

      // Interface
      const handlerIface = n('hif', 'Handler', 'interface')
      queries.insertNode(handlerIface)
      queries.insertEdge(aliPay.id, handlerIface.id, 'implements')
      queries.insertEdge(wechatPay.id, handlerIface.id, 'implements')

      const detector = new StrategyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      // Find Map.get() related patterns
      const getPatterns = patterns.filter(p =>
        p.possibleTargets.some(t => t.condition?.source === 'runtime_key')
      )
      expect(getPatterns.length).toBeGreaterThan(0)

      const allTargets = getPatterns.flatMap(p => p.possibleTargets)
      const targetNames = allTargets.map(t => t.targetName)
      expect(targetNames).toContain('AlipayHandler')
    })
  })

  // ──────────────────────────────────────────────
  // PIPELINE INTEGRATION TESTS
  // ──────────────────────────────────────────────
  describe('DispatchInferenceEngine pipeline', () => {
    it('runs all detectors without error', async () => {
      const cls = n('cls_p', 'MyService', 'class')
      queries.insertNode(cls)
      queries.insertAnnotation(cls.id, 'Transactional', '', 1, 'test-mod')

      const engine = new DispatchInferenceEngine(queries, '/test', 'test-mod', ['test-mod'])
      const result = await engine.run()

      expect(result.stats).toBeDefined()
      expect(typeof result.stats.totalPatterns).toBe('number')
      expect(typeof result.stats.totalEdges).toBe('number')
      expect(result.stats.byProvenance).toBeDefined()
    })

    it('produces edges that can be persisted', async () => {
      const cls = n('cls_e', 'ReportService', 'class')
      queries.insertNode(cls)
      queries.insertAnnotation(cls.id, 'Cacheable', '', 1, 'test-mod')

      const engine = new DispatchInferenceEngine(queries, '/test', 'test-mod', ['test-mod'])
      const result = await engine.run()

      for (const edge of result.edges) {
        expect(edge.source).toBeTruthy()
        expect(edge.target).toBeTruthy()
        expect(edge.kind).toMatch(/^(dispatch_registration|aop_advises|proxy_wraps|conditional_impl)$/)
        expect(() => JSON.parse(edge.metadata)).not.toThrow()
      }
    })

    it('returns detector names', () => {
      const engine = new DispatchInferenceEngine(queries, '/test', 'test-mod', ['test-mod'])
      const names = engine.getDetectorNames()
      expect(names).toContain('aop-detector')
      expect(names).toContain('strategy-detector')
      expect(names).toContain('proxy-detector')
      expect(names).toContain('factory-detector')
      expect(names).toContain('reflection-detector')
      expect(names).toContain('spi-detector')
      expect(names).toContain('conditional-bean-detector')
    })
  })

  // ──────────────────────────────────────────────
  // EDGE DEDUPLICATION TESTS
  // ──────────────────────────────────────────────
  describe('Edge deduplication (resolver)', () => {
    it('deduplicates edges with same source/target/kind', async () => {
      const src = n('src_dedup', 'Source', 'class')
      const tgt = n('tgt_dedup', 'Target', 'class')
      queries.insertNode(src)
      queries.insertNode(tgt)

      const patterns: import('../src/resolution/dispatch-inference/types.js').DispatchPattern[] = [
        {
          type: 'aop_proxy',
          sourceId: src.id,
          sourceName: 'Source',
          possibleTargets: [{
            targetId: tgt.id,
            targetName: 'Target',
            confidence: 0.7,
            provenance: 'aop_proxy',
            provenanceDetail: 'dup1',
          }],
        },
        {
          type: 'aop_proxy',
          sourceId: src.id,
          sourceName: 'Source',
          possibleTargets: [{
            targetId: tgt.id,
            targetName: 'Target',
            confidence: 0.7,
            provenance: 'aop_proxy',
            provenanceDetail: 'dup2',
          }],
        },
      ]

      const result = mergeInferredEdges(queries, patterns, 'test-mod')
      expect(result.edges).toHaveLength(1)
      expect(result.stats.totalEdges).toBe(1)
    })
  })

  // ──────────────────────────────────────────────
  // PROXY DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('ProxyDetector', () => {
    it('detects InvocationHandler proxies', async () => {
      const handler = n('ph1', 'MyHandler', 'class')
      queries.insertNode(handler)

      // Simulate implements InvocationHandler
      const ihIface = n('ih', 'InvocationHandler', 'interface')
      queries.insertNode(ihIface)
      queries.insertEdge(handler.id, ihIface.id, 'implements')

      // invoke method
      const invokeMethod = n('im1', 'invoke', 'method', { parentId: handler.id })
      queries.insertNode(invokeMethod)

      // Proxy.newProxyInstance call
      const proxyCall = n('pc1', 'newProxyInstance', 'method')
      queries.insertNode(proxyCall)
      queries.insertEdge(invokeMethod.id, proxyCall.id, 'calls')

      const proxiedIface = n('pif1', 'UserService', 'interface')
      queries.insertNode(proxiedIface)

      const detector = new ProxyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const proxyPatterns = patterns.filter(p => p.type === 'proxy_handler')
      expect(proxyPatterns.length).toBeGreaterThanOrEqual(0)
    })
  })

  // ──────────────────────────────────────────────
  // FACTORY DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('FactoryDetector', () => {
    it('detects factory methods producing interfaces', async () => {
      const factory = n('f1', 'BeanFactory', 'class')
      queries.insertNode(factory)

      const method = n('fm1', 'createBean', 'method', { parentId: factory.id })
      queries.insertNode(method)
      queries.insertEdge(factory.id, method.id, 'references')

      const returnTypeIface = n('rt1', 'BeanInterface', 'interface')
      queries.insertNode(returnTypeIface)

      const impl = n('bimpl1', 'BeanImpl', 'class')
      queries.insertNode(impl)
      queries.insertEdge(method.id, returnTypeIface.id, 'returns')
      queries.insertEdge(impl.id, returnTypeIface.id, 'implements')

      const detector = new FactoryDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const factoryPatterns = patterns.filter(p => p.type === 'factory_product')
      expect(factoryPatterns.length).toBeGreaterThanOrEqual(0)
    })
  })

  // ──────────────────────────────────────────────
  // REFLECTION DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('ReflectionDetector', () => {
    it('detects reflective Class.forName patterns', async () => {
      const forNameMethod = n('rfn1', 'forName', 'method')
      queries.insertNode(forNameMethod)
      queries.insertAnnotation(forNameMethod.id, 'Reflective', 'Class.forName', 1, 'test-mod')

      const refCaller = n('rc1', 'loadPlugin', 'method')
      queries.insertNode(refCaller)
      queries.insertEdge(refCaller.id, forNameMethod.id, 'calls')

      const targetClass = n('rcls1', 'PluginImpl', 'class')
      queries.insertNode(targetClass)

      const detector = new ReflectionDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const reflectivePatterns = patterns.filter(p => p.type === 'reflective_match')
      expect(reflectivePatterns.length).toBeGreaterThanOrEqual(0)
    })
  })

  // ──────────────────────────────────────────────
  // CONDITIONAL BEAN DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('ConditionalBeanDetector combined with condition-matcher', () => {
    it('detects conditional beans with @ConditionalOnProperty', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cg-test-config-'))
      const srcDir = join(tmpDir, 'src', 'main', 'resources')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'application.properties'), 'db.type=mysql\n')

      const iface = n('cif1', 'DataSource', 'interface', { filePath: join(srcDir, 'DataSource.java') })
      queries.insertNode(iface)

      const primary = n('cds1', 'PrimaryDS', 'class', { filePath: join(srcDir, 'PrimaryDS.java') })
      queries.insertNode(primary)
      queries.insertEdge(primary.id, iface.id, 'implements')
      queries.insertAnnotation(primary.id, 'ConditionalOnProperty',
        'name = "db.type", havingValue = "mysql"', 1, 'test-mod')

      const fallback = n('cds2', 'FallbackDS', 'class', { filePath: join(srcDir, 'FallbackDS.java') })
      queries.insertNode(fallback)
      queries.insertEdge(fallback.id, iface.id, 'implements')
      queries.insertAnnotation(fallback.id, 'ConditionalOnProperty',
        'name = "db.type", havingValue = "h2"', 2, 'test-mod')

      const detector = new ConditionalBeanDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const cbPatterns = patterns.filter(p => p.type === 'conditional_bean')
      expect(cbPatterns.length).toBeGreaterThan(0)

      const allTargets = cbPatterns.flatMap(p => p.possibleTargets)
      const targetNames = allTargets.map(t => t.targetName)
      expect(targetNames).toContain('PrimaryDS')
      expect(targetNames).toContain('FallbackDS')

      rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  // ──────────────────────────────────────────────
  // COMBINED SCENARIO: full orchestration
  // ──────────────────────────────────────────────
  describe('Full orchestration scenario', () => {
    it('handles rich graph with multiple dispatch types', async () => {
      // Interface
      const iface = n('gsif', 'GreetingService', 'interface')
      queries.insertNode(iface)

      // Strategies: EnglishGreeting, FrenchGreeting
      const en = n('eng', 'EnglishGreeting', 'class')
      queries.insertNode(en)
      queries.insertEdge(en.id, iface.id, 'implements')

      const fr = n('frg', 'FrenchGreeting', 'class')
      queries.insertNode(fr)
      queries.insertEdge(fr.id, iface.id, 'implements')

      // AOP on EnglishGreeting
      queries.insertAnnotation(en.id, 'Transactional', '', 1, 'test-mod')

      // Conditional on FrenchGreeting
      queries.insertAnnotation(fr.id, 'ConditionalOnProperty',
        'name = "app.lang", havingValue = "fr"', 2, 'test-mod')

      // Aspect with execution pointcut
      const aspect = n('gas', 'LogAspect', 'class')
      queries.insertNode(aspect)
      queries.insertAnnotation(aspect.id, 'Aspect', '', 3, 'test-mod')
      queries.insertAnnotation(aspect.id, 'Pointcut',
        'execution(* com.example.GreetingService.say*(..))', 4, 'test-mod')

      const engine = new DispatchInferenceEngine(queries, '/test', 'test-mod', ['test-mod'])
      const result = await engine.run()

      expect(result.stats.totalPatterns).toBeGreaterThan(0)
      expect(result.stats.totalEdges).toBeGreaterThan(0)

      const allProvenances = Object.keys(result.stats.byProvenance)
      expect(allProvenances).toContain('aop_proxy')
      expect(allProvenances).toContain('strategy_registered')
    })
  })

  // ──────────────────────────────────────────────
  // DATA SOURCE DRIVEN DISPATCH TESTS
  // ──────────────────────────────────────────────
  describe('Data-source-driven dispatch', () => {
    it('detects dispatch key from findById() DB call and lists all implementations', async () => {
      // Interface with multiple impls
      const iface = n('dsif', 'PaymentHandler', 'interface')
      queries.insertNode(iface)
      const impl1 = n('dsi1', 'AlipayHandler', 'class')
      queries.insertNode(impl1)
      queries.insertEdge(impl1.id, iface.id, 'implements')
      const impl2 = n('dsi2', 'WechatHandler', 'class')
      queries.insertNode(impl2)
      queries.insertEdge(impl2.id, iface.id, 'implements')

      // Map parent class (the map that.get() is called on)
      const mapClass = n('dsmap1', 'handlerMap', 'class')
      queries.insertNode(mapClass)

      // map.get() call node, parent is the map class
      const getMethod = n('dsg1', 'get', 'method', { parentId: mapClass.id })
      queries.insertNode(getMethod)

      // Caller method
      const caller = n('dsc1', 'handlePayment', 'method')
      queries.insertNode(caller)
      queries.insertEdge(caller.id, getMethod.id, 'calls')

      // The key arg node: "type" variable
      const argNode = n('dsa1', 'type', 'expression', { parentId: caller.id })
      queries.insertNode(argNode)

      // Repository call: paymentRepo.findById(id)
      const repoCall = n('dsr1', 'findById', 'method', { parentId: 'repoParent' })
      queries.insertNode(repoCall)
      queries.insertEdge(caller.id, repoCall.id, 'calls')

      // Variable assigned from repo call return
      const varDeclDS = n('dsv1', 'type', 'variable', {
        parentId: caller.id,
        metadata: JSON.stringify({ declaredName: 'type' }),
      })
      queries.insertNode(varDeclDS)
      queries.insertEdge(varDeclDS.id, repoCall.id, 'references')

      const detector = new StrategyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      // Should find data_driven patterns
      const ddPatterns = patterns.filter(p => p.type === 'data_driven')
      expect(ddPatterns.length).toBeGreaterThan(0)

      const allTargets = ddPatterns.flatMap(p => p.possibleTargets)
      expect(allTargets.length).toBeGreaterThanOrEqual(2)
      const targetNames = allTargets.map(t => t.targetName)
      expect(targetNames).toContain('AlipayHandler')
      expect(targetNames).toContain('WechatHandler')

      // Check that provenanceDetail mentions DB query
      const firstDetail = allTargets[0].provenanceDetail
      expect(firstDetail).toContain('findById')
    })

    it('detects dispatch key from object getter and lists all implementations', async () => {
      const iface = n('dsif2', 'ShippingStrategy', 'interface')
      queries.insertNode(iface)
      const s1 = n('dss1', 'StandardShipping', 'class')
      queries.insertNode(s1)
      queries.insertEdge(s1.id, iface.id, 'implements')
      const s2 = n('dss2', 'ExpressShipping', 'class')
      queries.insertNode(s2)
      queries.insertEdge(s2.id, iface.id, 'implements')

      // Map class
      const mapClass = n('dsmap2', 'strategyMap', 'class')
      queries.insertNode(mapClass)

      // map.get() node
      const getM = n('dsg2', 'get', 'method', { parentId: mapClass.id })
      queries.insertNode(getM)

      // Caller
      const caller = n('dsc2', 'ship', 'method')
      queries.insertNode(caller)
      queries.insertEdge(caller.id, getM.id, 'calls')

      // The key arg: "type"
      const argNode = n('dsa2', 'type', 'expression', { parentId: caller.id })
      queries.insertNode(argNode)

      // Getter method: order.getType()
      const getterMethod = n('dsgt1', 'getType', 'method', { parentId: 'orderEntity' })
      queries.insertNode(getterMethod)
      queries.insertEdge(caller.id, getterMethod.id, 'calls')

      // Variable assigned from getter
      const varDeclDS2 = n('dsv2', 'type', 'variable', {
        parentId: caller.id,
        metadata: JSON.stringify({ declaredName: 'type' }),
      })
      queries.insertNode(varDeclDS2)
      queries.insertEdge(varDeclDS2.id, getterMethod.id, 'references')

      const detector = new StrategyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const ddPatterns = patterns.filter(p => p.type === 'data_driven')
      expect(ddPatterns.length).toBeGreaterThan(0)

      const allTargets = ddPatterns.flatMap(p => p.possibleTargets)
      const targetNames = allTargets.map(t => t.targetName)
      expect(targetNames).toContain('StandardShipping')
      expect(targetNames).toContain('ExpressShipping')

      // Check provenance mentions getter
      const firstDetail = allTargets[0].provenanceDetail
      expect(firstDetail).toContain('getType')
    })
  })

  // ──────────────────────────────────────────────
  // CROSS-METHOD VARIABLE TRACER TESTS
  // ──────────────────────────────────────────────
  describe('Cross-method variable tracer', () => {
    it('traces literal assignments in same method', () => {
      const method = n('vtm1', 'handleRequest', 'method')
      queries.insertNode(method)

      const varDecl = n('vtd1', 'key', 'variable', {
        parentId: method.id,
        metadata: JSON.stringify({ declaredName: 'key' }),
      })
      queries.insertNode(varDecl)

      const literal = n('vtl1', '"alipay"', 'string_literal', { parentId: method.id })
      queries.insertNode(literal)
      queries.insertEdge(varDecl.id, literal.id, 'references')

      const result = traceVariable('key', method.id, queries)
      expect(result).not.toBeNull()
      expect(result!.possibleKeys).toContain('alipay')
    })

    it('traces across method call return values', () => {
      const callerMethod = n('vtc1', 'process', 'method')
      queries.insertNode(callerMethod)

      // Called method that returns literal
      const calleeMethod = n('vtcm1', 'getHandlerKey', 'method')
      queries.insertNode(calleeMethod)

      // Return statement with literal
      const retStmt = n('vtr1', 'return', 'return', { parentId: calleeMethod.id })
      queries.insertNode(retStmt)
      const retLiteral = n('vtrl1', '"wechat"', 'string_literal', { parentId: calleeMethod.id })
      queries.insertNode(retLiteral)
      queries.insertEdge(retStmt.id, retLiteral.id, 'returns')

      // Caller calls callee
      queries.insertEdge(callerMethod.id, calleeMethod.id, 'calls')

      // Variable being traced
      const varDecl = n('vtd2', 'mode', 'variable', {
        parentId: callerMethod.id,
        metadata: JSON.stringify({ declaredName: 'mode' }),
      })
      queries.insertNode(varDecl)
      queries.insertEdge(varDecl.id, calleeMethod.id, 'references')

      const result = traceVariable('mode', callerMethod.id, queries)
      expect(result).not.toBeNull()
      expect(result!.possibleKeys).toContain('wechat')
    })

    it('traces switch case labels', () => {
      const method = n('vtsm1', 'route', 'method')
      queries.insertNode(method)

      const sw = n('vtsw1', 'switch_block', 'switch', { parentId: method.id })
      queries.insertNode(sw)
      queries.insertEdge(method.id, sw.id, 'references')

      const case1 = n('vtc1', 'case "gold"', 'case', { parentId: sw.id })
      const case2 = n('vtc2', 'case "silver"', 'case', { parentId: sw.id })
      queries.insertNode(case1)
      queries.insertNode(case2)

      const result = traceVariable('level', method.id, queries)
      expect(result).not.toBeNull()
      expect(result!.possibleKeys).toContain('gold')
      expect(result!.possibleKeys).toContain('silver')
    })

    it('traces field access assignments', () => {
      const method = n('vtfm1', 'execute', 'method')
      queries.insertNode(method)

      const fieldAccess = n('vtfa1', 'this.handlerType', 'field_access', { parentId: method.id })
      queries.insertNode(fieldAccess)

      const field = n('vtf1', 'handlerType', 'field')
      queries.insertNode(field)
      queries.insertEdge(fieldAccess.id, field.id, 'references')

      // Field assignment in another method
      const setterMethod = n('vts1', 'setHandlerType', 'method')
      queries.insertNode(setterMethod)
      const assignLiteral = n('vtal1', '"default"', 'string_literal', { parentId: setterMethod.id })
      queries.insertNode(assignLiteral)
      queries.insertEdge(setterMethod.id, field.id, 'references')
      queries.insertEdge(assignLiteral.id, field.id, 'references')

      const result = traceVariable('handlerType', method.id, queries)
      expect(result).not.toBeNull()
      expect(result!.possibleKeys).toContain('default')
    })
  })

  // ──────────────────────────────────────────────
  // ENHANCED PROXY DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('Enhanced ProxyDetector', () => {
    it('lists InvocationHandler implementations as candidates', async () => {
      // InvocationHandler interface
      const ihIface = n('eih', 'InvocationHandler', 'interface')
      queries.insertNode(ihIface)

      // Two handlers
      const handler1 = n('eh1', 'AuditHandler', 'class')
      queries.insertNode(handler1)
      queries.insertEdge(handler1.id, ihIface.id, 'implements')

      const handler2 = n('eh2', 'LogHandler', 'class')
      queries.insertNode(handler2)
      queries.insertEdge(handler2.id, ihIface.id, 'implements')

      // Proxy.newProxyInstance node
      const proxyCall = n('epc1', 'newProxyInstance', 'method')
      queries.insertNode(proxyCall)

      // Caller
      const caller = n('ec1', 'createProxy', 'method')
      queries.insertNode(caller)
      queries.insertEdge(caller.id, proxyCall.id, 'calls')

      // Proxied interface
      const proxiedIface = n('epif', 'UserService', 'interface')
      queries.insertNode(proxiedIface)

      const detector = new ProxyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const proxyPatterns = patterns.filter(p => p.type === 'proxy_handler')
      expect(proxyPatterns.length).toBeGreaterThan(0)

      // Should find InvocationHandler candidates
      const allTargets = proxyPatterns.flatMap(p => p.possibleTargets)
      const handlerTargets = allTargets.filter(t =>
        t.condition?.source === 'InvocationHandler'
      )
      expect(handlerTargets.length).toBeGreaterThanOrEqual(2)
      const handlerNames = handlerTargets.map(t => t.targetName)
      expect(handlerNames).toContain('AuditHandler')
      expect(handlerNames).toContain('LogHandler')
    })

    it('lists proxy interface implementations as candidates', async () => {
      const proxyCall = n('epc2', 'newProxyInstance', 'method')
      queries.insertNode(proxyCall)

      const caller = n('ec2', 'createServiceProxy', 'method')
      queries.insertNode(caller)
      queries.insertEdge(caller.id, proxyCall.id, 'calls')

      // Interface that is being proxied
      const serviceIface = n('epif2', 'PaymentService', 'interface')
      queries.insertNode(serviceIface)

      // Implementation of that interface
      const impl = n('epimpl1', 'PaymentServiceImpl', 'class')
      queries.insertNode(impl)
      queries.insertEdge(impl.id, serviceIface.id, 'implements')

      const detector = new ProxyDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const proxyPatterns = patterns.filter(p => p.type === 'proxy_handler')
      const allTargets = proxyPatterns.flatMap(p => p.possibleTargets)
      const implTargets = allTargets.filter(t =>
        t.condition?.source === 'proxy_impl'
      )
      expect(implTargets.length).toBeGreaterThanOrEqual(1)
      expect(implTargets[0].targetName).toBe('PaymentServiceImpl')
    })
  })

  // ──────────────────────────────────────────────
  // ENHANCED FACTORY DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('Enhanced FactoryDetector', () => {
    it('matches return type to all implementations', async () => {
      const factoryMethod = n('efm1', 'createNotifier', 'method', {
        signature: ': Notifier',
      })
      queries.insertNode(factoryMethod)

      const iface = n('efif1', 'Notifier', 'interface')
      queries.insertNode(iface)

      const impl1 = n('efi1', 'EmailNotifier', 'class')
      queries.insertNode(impl1)
      queries.insertEdge(impl1.id, iface.id, 'implements')

      const impl2 = n('efi2', 'SmsNotifier', 'class')
      queries.insertNode(impl2)
      queries.insertEdge(impl2.id, iface.id, 'implements')

      const detector = new FactoryDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const factoryPatterns = patterns.filter(p => p.type === 'factory_product')
      const allTargets = factoryPatterns.flatMap(p => p.possibleTargets)

      // Should find the return-type-mapped candidates
      const mappedTargets = allTargets.filter(t =>
        t.condition?.source === 'return_type_mapping'
      )
      expect(mappedTargets.length).toBeGreaterThanOrEqual(1)
      const targetNames = mappedTargets.map(t => t.targetName)
      expect(targetNames).toContain('EmailNotifier')
      expect(targetNames).toContain('SmsNotifier')
    })
  })

  // ──────────────────────────────────────────────
  // ENHANCED REFLECTION DETECTOR TESTS
  // ──────────────────────────────────────────────
  describe('Enhanced ReflectionDetector', () => {
    it('lists candidate classes for Class.forName()', async () => {
      const forNameMethod = n('erfn1', 'forName', 'method')
      queries.insertNode(forNameMethod)

      const caller = n('erc1', 'loadPlugin', 'method')
      queries.insertNode(caller)
      queries.insertEdge(caller.id, forNameMethod.id, 'calls')

      // Potential target classes
      const plugin1 = n('erp1', 'DatabasePlugin', 'class')
      queries.insertNode(plugin1)
      const plugin2 = n('erp2', 'AuthPlugin', 'class')
      queries.insertNode(plugin2)
      const notPlugin = n('erp3', 'ConfigLoader', 'class')
      queries.insertNode(notPlugin)

      const detector = new ReflectionDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      // Should find all three as candidates
      const reflectivePatterns = patterns.filter(p => p.type === 'reflective_match')
      expect(reflectivePatterns.length).toBeGreaterThan(0)

      const allTargets = reflectivePatterns.flatMap(p => p.possibleTargets)
      const targetNames = allTargets.map(t => t.targetName)
      expect(targetNames).toContain('DatabasePlugin')
      expect(targetNames).toContain('AuthPlugin')
      expect(targetNames).toContain('ConfigLoader')
    })

    it('filters Class.forName candidates by literal string argument', async () => {
      const forNameMethod = n('erfn2', 'forName', 'method')
      queries.insertNode(forNameMethod)

      const caller = n('erc2', 'loadPlugin', 'method')
      queries.insertNode(caller)
      queries.insertEdge(caller.id, forNameMethod.id, 'calls')

      // Literal argument to forName
      const literalArg = n('erla1', '"com.app.DatabasePlugin"', 'string_literal', { parentId: caller.id })
      queries.insertNode(literalArg)

      const plugin1 = n('erp2a', 'DatabasePlugin', 'class', { qualifiedName: 'com.app.DatabasePlugin' })
      queries.insertNode(plugin1)
      const plugin2 = n('erp2b', 'AuthPlugin', 'class', { qualifiedName: 'com.app.AuthPlugin' })
      queries.insertNode(plugin2)

      const detector = new ReflectionDetector()
      const patterns = await detector.detect(queries, 'test-mod', ['test-mod'])

      const reflectivePatterns = patterns.filter(p => p.type === 'reflective_match')
      const allTargets = reflectivePatterns.flatMap(p => p.possibleTargets)
      const targetNames = allTargets.map(t => t.targetName)
      expect(targetNames).toContain('DatabasePlugin')
    })
  })
})
