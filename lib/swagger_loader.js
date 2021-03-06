'use strict';
const path = require('path');
const fs = require('fs');
const SwaggerVersion = '2.0';

const generateDefinitions = require('./definition_reader');

module.exports = app => {
  const suffix = app.config.swaggerdoc.suffix;
  let swagger = {};
  swagger.host = '';
  swagger.swagger = SwaggerVersion;
  swagger.basePath = app.config.swaggerdoc.basePath;
  swagger.info = app.config.swaggerdoc.apiInfo;
  swagger.schemes = app.config.swaggerdoc.schemes;
  swagger.tags = [];
  swagger.paths = {};
  let securitys = [];
  if (app.config.swaggerdoc.enableSecurity) {
    swagger.securityDefinitions = app.config.swaggerdoc.securityDefinitions;
    Object.keys(swagger.securityDefinitions).forEach(i => {
      securitys.push(i);
    });
  }
  swagger.definitions = generateDefinitions(app);

  // 解析文件注释，组装swagger json, 只解析目录第一层，不深入解析
  const scannerDir = path.join(app.config.baseDir, app.config.swaggerdoc.dirScanner);
  const names = fs.readdirSync(scannerDir);
  const ObjectType = ['boolean', 'integer', 'number', 'string'];

  for (let name of names) {
    const filepath = path.join(scannerDir, name);
    const stat = fs.statSync(filepath);
    if (stat.isFile() && path.extname(name) === suffix) {
      let blocks = generate_comments_block(filepath);
      // 如果第一个注释块不包含@controller不对该文件注释解析
      if (!blocks || !has_controller(blocks[0])) continue;

      // 当前注释块集合的所属tag-group, 并添加至swagger.tags中
      let controller = get_comments(
        blocks[0],
        /(@Controller.*\r\n)|(@Controller.*\r)|(@Controller.*\n)/gm
      )[0];
      let tagName = controller[1] ? controller[1] : name.split(suffix)[0];
      swagger.tags.push({ name: tagName, description: controller[2] ? controller[2] : '' });

      let routerlist = [];
      for (let i = 1; i < blocks.length; i++) {
        // 解析路由
        let routers = get_comments(blocks[i], /(@Router.*\r\n)|(@Router.*\r)|(@Router.*\n)/gm);
        if (routers) {
          let path_method = {};
          path_method.tags = [tagName];
          path_method.summary = '';
          path_method.description = '';
          path_method.operationId = `${name.split('.')[0]}-${i}`;
          path_method.consumes = app.config.swaggerdoc.consumes;
          path_method.produces = app.config.swaggerdoc.produces;
          path_method.parameters = [];
          path_method.security = [];
          path_method.responses = {};
          path_method.responses.default = { description: 'successful operation' };

          // 解析security
          for (let security of securitys) {
            if (blocks[i].indexOf(`@${security}`) > -1) {
              let securityItem = {};
              if (swagger.securityDefinitions[security].type === 'apiKey') {
                securityItem[security] = [];
              }
              if (swagger.securityDefinitions[security].type === 'oauth2') {
                securityItem[security] = [];
                Object.keys(swagger.securityDefinitions[security].scopes).forEach(i => {
                  securityItem[security].push(i);
                });
              }
              path_method.security.push(securityItem);
            }
          }

          // 解析Deprecated
          if (blocks[i].indexOf('@Deprecated') > -1) {
            path_method.deprecated = true;
          }

          // 解析summary
          let summarys = get_comments(
            blocks[i],
            /(@Summary.*\r\n)|(@Summary.*\r)|(@Summary.*\n)/gm
          );
          if (summarys) {
            path_method.summary = summarys[0][1];
            path_method.summary = '';
            let m = 1;
            while (summarys[0][m]) {
              path_method.summary = path_method.summary + summarys[0][m] + ' ';
              m++;
            }
          }

          // 解析description
          let descriptions = get_comments(
            blocks[i],
            /(@Description.*\r\n)|(@Description.*\r)|(@Description.*\n)/gm
          );
          if (descriptions) {
            path_method.description = '';
            let m = 1;
            while (descriptions[0][m]) {
              path_method.description = path_method.description + descriptions[0][m] + ' ';
              m++;
            }
          }

          // 解析请求参数
          let requests = get_comments(
            blocks[i],
            /(@Request.*\r\n)|(@Request.*\r)|(@Request.*\n)/gm
          );
          if (requests) {
            for (let request of requests) {
              let parameter = generate_parameters(request, routers, swagger.definitions);
              path_method.parameters.push(parameter);
            }
          }

          // 解析响应参数
          let responses = get_comments(
            blocks[i],
            /(@Response.*\r\n)|(@Response.*\r)|(@Response.*\n)/gm
          );
          if (responses) {
            for (let response of responses) {
              let res = {};
              let schema = {};
              let itemsType = response[2];
              if (
                !swagger.definitions.hasOwnProperty(response[2]) &&
                !ObjectType.includes(itemsType)
              ) {
                throw new Error(
                  `[egg-swagger-doc] error at ${routers[0][1].toLowerCase()}:${
                    routers[0][2]
                  } ,the type of response parameter does not exit`
                );
              }

              if (ObjectType.includes(itemsType)) {
                schema.type = itemsType;
              } else {
                schema.$ref = `#/definitions/${response[2]}`;
              }
              res.schema = schema;
              res.description = '';
              if (response[3]) {
                let m = 3;
                while (response[m]) {
                  res.description = res.description + response[m] + ' ';
                  m++;
                }
              }

              path_method.responses[response[1]] = res;
            }
          }

          if (!routerlist.includes(routers[0][2])) {
            swagger.paths[routers[0][2]] = {};
          }

          routerlist.push(routers[0][2]);
          swagger.paths[routers[0][2]][routers[0][1].toLowerCase()] = path_method;
        }
      }
    }
  }
  return swagger;
};

/**
 * 获取块中包含指定标识的注释行，返回行中以空格分割的得到的数组
 * @param {String} comments 注释
 * @param {String} regex 正则式
 * @return {*} 匹配成功返回行中以空格分割的得到的数组，否则false
 */
function get_comments(comments, regex) {
  let result = [];
  let comment_lines = comments.match(regex);
  if (comment_lines) {
    for (let comment_line of comment_lines) {
      result.push(
        comment_line
          .slice(1, comment_line.length - 1)
          .replace('\r', '')
          .split(' ')
      );
    }
    return result;
  }
  return false;
}

/**
 * 获取指定文件中的注释块集合
 * @param {String} filePath 文件路径
 * @return {Array} 返回注释块集合
 */
function generate_comments_block(filePath) {
  let buffer = fs.readFileSync(filePath);
  let fileString = buffer.toString();
  const block_regex = /\/\*\*([\s\S]*?)\*\//gm;
  return fileString.match(block_regex);
}

/**
 * 判断是否包含@Controller标签
 * @param {String} block 注释块
 * @return {Boolean} 是否包含@Controller标签
 */
function has_controller(block) {
  return block.indexOf('@Controller') > -1;
}

/**
 * 获取请求参数
 * @param {String} request 包含@Request的注释行,以空格分割的得到的数组
 * @param {string[]} routers 路由信息
 * @param {object} definitions contract信息
 * @return {Object} swagger parameter
 */
function generate_parameters(request, routers, definitions) {
  let parameter = {};

  parameter.in = request[1];
  if (request[1].toLowerCase() !== 'body') {
    parameter.type = request[2];
  } else {
    let schema = {};
    if (!request[2].startsWith('array')) {
      if (!definitions.hasOwnProperty(request[2])) {
        throw new Error(
          `[egg-swagger-doc] error at ${routers[0][1].toLowerCase()}:${
            routers[0][2]
          } ,the type of request parameter does not exit`
        );
      }
      schema.$ref = `#/definitions/${request[2]}`;
    } else {
      schema.type = 'array';
      let items = {};
      let itemsType = request[2].substring(6, request[2].length - 1);
      if (ObjectType.includes(itemsType)) {
        items.type = itemsType;
      } else {
        if (!definitions.hasOwnProperty(itemsType)) {
          throw new Error(
            `[egg-swagger-doc] error at ${routers[0][1].toLowerCase()}:${
              routers[0][2]
            } ,the type of request parameter does not exit`
          );
        }
        items.$ref = `#/definitions/${itemsType}`;
      }
      schema.items = items;
    }

    parameter.schema = schema;
  }

  parameter.name = request[3].replace('*', '');

  parameter.required = false;
  if (request[3].indexOf('*') > -1) {
    parameter.required = true;
  }

  parameter.description = '';

  let i = 4;
  while (request[i]) {
    parameter.description = parameter.description + request[i] + ' ';
    i++;
  }

  return parameter;
}
