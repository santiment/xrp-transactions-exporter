const pkg = require('./package.json');
const { send } = require('micro')
const url = require('url')
const { Exporter } = require('san-exporter')
const RippleAPI = require('ripple-lib').RippleAPI
const PQueue = require('p-queue')
const metrics = require('san-exporter/metrics')
const { logger } = require('./logger')
const assert = require('assert')

const exporter = new Exporter(pkg.name)

const SEND_BATCH_SIZE = parseInt(process.env.SEND_BATCH_SIZE || "30")
const DEFAULT_WS_TIMEOUT = parseInt(process.env.DEFAULT_WS_TIMEOUT || "10000")
const CONNECTIONS_COUNT = parseInt(process.env.CONNECTIONS_COUNT || "1")
const MAX_CONNECTION_CONCURRENCY = parseInt(process.env.MAX_CONNECTION_CONCURRENCY || "10")
// A comma separated list of Ripple API endpoints.
const XRP_NODE_URLS = process.env.XRP_NODE_URLS || 'wss://s2.ripple.com'
const EXPORT_TIMEOUT_MLS = parseInt(process.env.EXPORT_TIMEOUT_MLS || 1000 * 60 * 5)     // 5 minutes
// Although we request the last 'validated' block we are seeing blocks which are neither validated nor even closed. We introduce this extra delay to prevent this.
// In terms of time, 20 blocks is a delay between 1 and 2 minutes.
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "20")

let connections = []
const nodeURLs = XRP_NODE_URLS.split(",");

let lastProcessedPosition = {
  blockNumber: parseInt(process.env.LEDGER || "32570"),
}
// To prevent healthcheck failing during initialization and processing first part of data, we set lastExportTime to current time.
let lastExportTime = Date.now()

logger.info('Fetching XRPL transactions...')

const connectionSend = (async ({connection, queue, index}, params) => {
  metrics.requestsCounter.labels(index).inc()

  const startTime = new Date()
  return queue.add(() => {
    const { command, ...arguments } = params

    return connection.request(command, arguments)
  }).then((result) => {
    metrics.requestsResponseTime.labels(index).observe(new Date() - startTime)

    return result
  })
})

const fetchLedgerTransactions = async (connection, ledger_index) => {
  let { ledger } = await connectionSend(connection, {
    command: 'ledger',
    ledger_index: parseInt(ledger_index),
    transactions: true,
    expand: false
  })

  assert(ledger.closed == true)

  if (typeof ledger.transactions === 'undefined' || ledger.transactions.length === 0) {
    // Do nothing
    return { ledger: ledger, transactions: [] }
  }

  if (ledger.transactions.length > 200) {
    // Lots of data. Per TX
    logger.info(`<<< MANY TXS at ledger ${ledger_index}: [[ ${ledger.transactions.length} ]], processing per-tx...`)
    let transactions = ledger.transactions.map(Tx =>
      connectionSend(connection, {
        command: 'tx',
        transaction: Tx,
        minLedgerVersion: ledger_index,
        maxLedgerVersion: ledger_index
      }).catch((error) => {
        if (error.message === 'txnNotFound') {
          return Promise.resolve(null)
        }

        return Promise.reject(error)
      })
    )

    transactions = await Promise.all(transactions)

    // Filter out the transactions failed transactions
    transactions = transactions.filter(t => t)

    return { ledger, transactions }
  }

  // Fetch at once.
  let result = await connectionSend(connection, {
    command: 'ledger',
    ledger_index: parseInt(ledger_index),
    transactions: true,
    expand: true
  })

  assert(result.ledger.closed == true)

  return { ledger: ledger, transactions: result.ledger.transactions }
}

function checkAllTransactionsValid(ledgers) {
  for (indexLedger = 0; indexLedger < ledgers.length; indexLedger++) {
    transactions = ledgers[indexLedger].transactions
    blockNumber = ledgers[indexLedger].ledger_index
    for (index = 0; index < transactions.length; index++) {
      const transaction = transactions[index]
      if(transaction.hasOwnProperty('validated') && !transaction.validated) {
        logger.error(`Transaction ${transaction.hash} at index ${index} in block ${ledgers[indexLedger].ledger.ledger_index} is not validated. Aborting.`)
        process.exit(-1)
      }
      if(!transaction.hasOwnProperty('meta') && !transaction.hasOwnProperty('metaData')) {
        logger.error(`Transaction ${transaction.hash} at index ${index} in block ${ledgers[indexLedger].ledger.ledger_index} is missing 'meta' field. Aborting.`)
        process.exit(-1)
      }
    }
  }
}

async function work() {
  const currentLedger = await connectionSend(connections[0], {
    command: 'ledger',
    ledger_index: 'validated',
    transactions: true,
    expand: false
  })

  const currentBlock = parseInt(currentLedger.ledger.ledger_index) - CONFIRMATIONS
  metrics.currentBlock.set(currentBlock)
  const requests = []

  logger.info(`Fetching transfers for interval ${lastProcessedPosition.blockNumber}:${currentBlock}`)

  while (lastProcessedPosition.blockNumber + requests.length <= currentBlock) {
    const ledgerToDownload = lastProcessedPosition.blockNumber + requests.length

    requests.push(fetchLedgerTransactions(connections[ledgerToDownload % connections.length], ledgerToDownload))

    if (requests.length >= SEND_BATCH_SIZE || ledgerToDownload == currentBlock) {
      const ledgers = await Promise.all(requests).map(async ({ledger, transactions}) => {
        metrics.downloadedTransactionsCounter.inc(transactions.length)
        metrics.downloadedBlocksCounter.inc()

        return { ledger, transactions, primaryKey: ledger.ledger_index }
      })

      checkAllTransactionsValid(ledgers);

      logger.info(`Flushing ledgers ${ledgers[0].primaryKey}:${ledgers[ledgers.length - 1].primaryKey}`)
      await exporter.sendDataWithKey(ledgers, "primaryKey")

      lastExportTime = Date.now()
      lastProcessedPosition.blockNumber += ledgers.length
      await exporter.savePosition(lastProcessedPosition)
      metrics.lastExportedBlock.set(lastProcessedPosition.blockNumber)

      requests.length = 0
    }
  }
}

async function initLastProcessedLedger() {
  const lastPosition = await exporter.getLastPosition()

  if (lastPosition) {
    lastProcessedPosition = lastPosition
    logger.info(`Resuming export from position ${JSON.stringify(lastPosition)}`)
  } else {
    await exporter.savePosition(lastProcessedPosition)
    logger.info(`Initialized exporter with initial position ${JSON.stringify(lastProcessedPosition)}`)
  }
}

async function fetchEvents() {
  try {
    await work()
  }
  catch(ex) {
    logger.error(ex)
    // This can throw if no more API endpoints left
    await createNewSetConnections();
  }

  logger.info(`Progressed to position ${JSON.stringify(lastProcessedPosition)}`)

  // Look for new events every 1 sec
  setTimeout(fetchEvents, 1000)
}

async function createNewSetConnections() {
  connections = []

  if (0 == nodeURLs.length) {
    // No more endpoints to try. Throw exception. Re-start the Pod.
    throw "Error: All API URLs returned error."
  }

  nodeURL = nodeURLs.shift()
  logger.info(`Using ${nodeURL} as Ripple API point.`)
  for (let i = 0; i < CONNECTIONS_COUNT; i++) {
    const api = new RippleAPI({
      server: nodeURL,
      timeout: DEFAULT_WS_TIMEOUT
    })

    await api.connect()

    connections.push({
      connection: api,
      queue: new PQueue({ concurrency: MAX_CONNECTION_CONCURRENCY }),
      index: i
    })
  }
}

const init = async () => {
  metrics.startCollection()
  await createNewSetConnections()

  await exporter.connect()
  await initLastProcessedLedger()
  await fetchEvents()
}

init()

const healthcheckKafka = () => {
  if (exporter.producer.isConnected()) {
    return Promise.resolve()
  } else {
    return Promise.reject("Kafka client is not connected to any brokers")
  }
}

const healthcheckExportTimeout = () => {
  const timeFromLastExport = Date.now() - lastExportTime
  const isExportTimeoutExceeded = timeFromLastExport > EXPORT_TIMEOUT_MLS
  logger.debug(`isExportTimeoutExceeded ${isExportTimeoutExceeded}, timeFromLastExport: ${timeFromLastExport}ms`)
  if (isExportTimeoutExceeded) {
    return Promise.reject(`Time from the last export ${timeFromLastExport}ms exceeded limit  ${EXPORT_TIMEOUT_MLS}ms.`)
  } else {
    return Promise.resolve()
  }
}

module.exports = async (request, response) => {
  const req = url.parse(request.url, true);

  switch (req.pathname) {
    case '/healthcheck':
      return healthcheckKafka()
          .then(() => healthcheckExportTimeout())
          .then(() => send(response, 200, "ok"))
          .catch((err) => send(response, 500, `Connection to kafka failed: ${err}`))

    case '/metrics':
      for (let i = 0; i < CONNECTIONS_COUNT; i++) {
        if (connections[i]) {
          const {queue, index} = connections[i]
          metrics.requestsQueueSize.labels(index).set(queue.size)
        }
      }

      response.setHeader('Content-Type', metrics.register.contentType);
      return send(response, 200, metrics.register.metrics())

    default:
      return send(response, 404, 'Not found');
  }
}
