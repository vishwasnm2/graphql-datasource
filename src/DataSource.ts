import defaults from 'lodash/defaults';

import {
  AnnotationEvent,
  AnnotationQueryRequest,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  ScopedVars,
  TimeRange,
} from '@grafana/data';

import { MyQuery, MyDataSourceOptions, defaultQuery } from './types';
import { dateTime, MutableDataFrame, FieldType, DataFrame } from '@grafana/data';
import _ from 'lodash';
import { flatten } from './util';

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  basicAuth: string | undefined;
  withCredentials: boolean | undefined;
  url: string | undefined;

  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>, private backendSrv: any, private templateSrv: any) {
    super(instanceSettings);
    this.basicAuth = instanceSettings.basicAuth;
    this.withCredentials = instanceSettings.withCredentials;
    this.url = instanceSettings.url;
  }

  private request(data: string) {
    const options: any = {
      url: this.url,
      method: 'POST',
      data: {
        query: data,
      },
    };

    if (this.basicAuth || this.withCredentials) {
      options.withCredentials = true;
    }
    if (this.basicAuth) {
      options.headers = {
        Authorization: this.basicAuth,
      };
    }

    return this.backendSrv.datasourceRequest(options);
  }

  private postQuery(query: Partial<MyQuery>, payload: string) {
    return this.request(payload)
      .then((results: any) => {
        return { query, results };
      })
      .catch((err: any) => {
        if (err.data && err.data.error) {
          throw {
            message: 'GraphQL error: ' + err.data.error.reason,
            error: err.data.error,
          };
        }

        throw err;
      });
  }

  private createQuery(query: MyQuery, range: TimeRange | undefined, scopedVars: ScopedVars | undefined = undefined) {
    let payload = query.queryText;
    if (range) {
      payload = payload.replace(/\$timeFrom/g, range.from.valueOf().toString());
      payload = payload.replace(/\$timeTo/g, range.to.valueOf().toString());
    }
    if (scopedVars) {
      payload = this.templateSrv.replace(payload, scopedVars);
    }

    //console.log(payload);
    return this.postQuery(query, payload);
  }
  private getDocs(results: any, dataPath: string): any[] {
    if (!results.data) {
      throw 'results.data does not exist!';
    }
    let data = dataPath.split('.').reduce((d: any, p: any) => {
      if (!d) {
        return null;
      }
      return d[p];
    }, results.data);
    if (!data) {
      const errors: any[] = results.data.errors;
      if (errors && errors.length !== 0) {
        throw errors[0];
      }
      throw 'd[p] did not exist and no errors were given!';
    }
    const docs: any[] = [];
    let pushDoc = (originalDoc: object) => {
      docs.push(flatten(originalDoc));
    };
    if (Array.isArray(data)) {
      for (const element of data) {
        pushDoc(element);
      }
    } else {
      pushDoc(data);
    }
    return docs;
  }

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    return Promise.all(
      options.targets.map(target => {
        return this.createQuery(defaults(target, defaultQuery), options.range, options.scopedVars);
      })
    ).then((results: any) => {
      const dataFrameArray: DataFrame[] = [];
      for (let res of results) {
        const docs: any[] = this.getDocs(res.results, res.query.dataPath);
        const { groupBy, aliasBy } = res.query;
        const split = groupBy.split(',');
        const groupByList: string[] = [];
        for (const element of split) {
          const trimmed = element.trim();
          if (trimmed) {
            groupByList.push(trimmed);
          }
        }

        const dataFrameMap = new Map<string, MutableDataFrame>();
        for (const doc of docs) {
          if (doc.Time) {
            doc.Time = dateTime(doc.Time);
          }
          const identifiers: string[] = [];
          for (const groupByElement of groupByList) {
            identifiers.push(doc[groupByElement]);
          }
          const identifiersString = identifiers.toString();
          let dataFrame = dataFrameMap.get(identifiersString);
          if (!dataFrame) {
            // we haven't initialized the dataFrame for this specific identifier that we group by yet
            dataFrame = new MutableDataFrame({ fields: [] });
            const generalReplaceObject: any = {};
            for (const fieldName in doc) {
              generalReplaceObject['field_' + fieldName] = doc[fieldName];
            }
            for (const fieldName in doc) {
              let t: FieldType = FieldType.string;
              if (fieldName === 'Time') {
                t = FieldType.time;
              } else if (_.isNumber(doc[fieldName])) {
                t = FieldType.number;
              }
              let title;
              if (identifiers.length !== 0) {
                // if we have any identifiers
                title = identifiersString + '_' + fieldName;
              } else {
                title = fieldName;
              }
              if (aliasBy) {
                title = aliasBy;
                const replaceObject = { ...generalReplaceObject };
                replaceObject['fieldName'] = fieldName;
                for (const replaceKey in replaceObject) {
                  const replaceValue = replaceObject[replaceKey];
                  const regex = new RegExp('\\$' + replaceKey, 'g');
                  title = title.replace(regex, replaceValue);
                }
                title = this.templateSrv.replace(title, options.scopedVars);
              }
              dataFrame.addField({
                name: fieldName,
                type: t,
                config: { title: title },
              }).parse = (v: any) => {
                return v || '';
              };
            }
            dataFrameMap.set(identifiersString, dataFrame);
          }

          dataFrame.add(doc);
        }
        for (const dataFrame of dataFrameMap.values()) {
          dataFrameArray.push(dataFrame);
        }
      }
      return { data: dataFrameArray };
    });
  }
  annotationQuery(options: AnnotationQueryRequest<MyQuery>): Promise<AnnotationEvent[]> {
    const query = defaults(options.annotation, defaultQuery);
    return Promise.all([this.createQuery(query, options.range)]).then((results: any) => {
      const r: AnnotationEvent[] = [];
      for (const res of results) {
        const docs: any[] = this.getDocs(res.results, options.annotation.dataPath);
        for (const doc of docs) {
          console.log(doc);
          const annotation: AnnotationEvent = {};
          if (doc.Time) {
            annotation.time = dateTime(doc.Time).valueOf();
          }
          if (doc.TimeEnd) {
            annotation.isRegion = true;
            annotation.timeEnd = dateTime(doc.TimeEnd).valueOf();
          }
          let title = query.annotationTitle;
          let text = query.annotationText;
          let tags = query.annotationTags;
          for (const fieldName in doc) {
            const fieldValue = doc[fieldName];
            const replaceKey = 'field_' + fieldName;
            const regex = new RegExp('\\$' + replaceKey, 'g');
            title = title.replace(regex, fieldValue);
            text = text.replace(regex, fieldValue);
            tags = tags.replace(regex, fieldValue);
          }

          annotation.title = title;
          annotation.text = text;
          const tagsList: string[] = [];
          for (const element of tags.split(',')) {
            const trimmed = element.trim();
            if (trimmed) {
              tagsList.push(trimmed);
            }
          }
          annotation.tags = tagsList;
          console.log(annotation);
          r.push(annotation);
        }
      }
      return r;
    });
  }

  testDatasource() {
    const q = `{
      __schema{
        queryType{name}
      }
    }`;
    return this.postQuery(defaultQuery, q).then(
      (res: any) => {
        if (res.errors) {
          console.log(res.errors);
          return {
            status: 'error',
            message: 'GraphQL Error: ' + res.errors[0].message,
          };
        }
        return {
          status: 'success',
          message: 'Success',
        };
      },
      (err: any) => {
        console.log(err);
        return {
          status: 'error',
          message: 'HTTP Response ' + err.status + ': ' + err.statusText,
        };
      }
    );
  }
}
