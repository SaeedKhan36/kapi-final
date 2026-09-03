/* eslint-disable */

// @ts-nocheck

import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as AppRouteImport } from './routes/app'
import { Route as RunsRunIdRouteImport } from './routes/runs/$runId'

const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)
const AppRoute = AppRouteImport.update({
  id: '/app',
  path: '/app',
  getParentRoute: () => rootRouteImport,
} as any)
const RunsRunIdRoute = RunsRunIdRouteImport.update({
  id: '/runs/$runId',
  path: '/runs/$runId',
  getParentRoute: () => rootRouteImport,
} as any)

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/app': typeof AppRoute
  '/runs/$runId': typeof RunsRunIdRoute
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
  '/app': typeof AppRoute
  '/runs/$runId': typeof RunsRunIdRoute
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/': typeof IndexRoute
  '/app': typeof AppRoute
  '/runs/$runId': typeof RunsRunIdRoute
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths: '/' | '/app' | '/runs/$runId'
  fileRoutesByTo: FileRoutesByTo
  to: '/' | '/app' | '/runs/$runId'
  id: '__root__' | '/' | '/app' | '/runs/$runId'
  fileRoutesById: FileRoutesById
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute
  AppRoute: typeof AppRoute
  RunsRunIdRoute: typeof RunsRunIdRoute
}

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/app': {
      id: '/app'
      path: '/app'
      fullPath: '/app'
      preLoaderRoute: typeof AppRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/runs/$runId': {
      id: '/runs/$runId'
      path: '/runs/$runId'
      fullPath: '/runs/$runId'
      preLoaderRoute: typeof RunsRunIdRouteImport
      parentRoute: typeof rootRouteImport
    }
  }
}

const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
  AppRoute: AppRoute,
  RunsRunIdRoute: RunsRunIdRoute,
}
export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>()
