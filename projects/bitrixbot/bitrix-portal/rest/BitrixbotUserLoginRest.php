<?php
/**
 * Custom REST: expose b_user.LOGIN (not available in standard user.get on this portal).
 *
 * Install: see docs/bitrix-login-custom-rest.md
 *
 * Method: bitrixbot.user.logins.list
 * Scope:  bitrixbot (grant to local app / inbound webhook)
 */

use Bitrix\Main\Loader;
use Bitrix\Main\UserTable;

final class BitrixbotUserLoginRest extends \IRestService
{
    public static function onRestServiceBuildDescription(): array
    {
        return [
            'bitrixbot' => [
                'bitrixbot.user.logins.list' => [
                    'callback' => [__CLASS__, 'listLogins'],
                    'options' => [],
                ],
            ],
        ];
    }

    /**
     * @param array<string, mixed> $query
     * @param int $nav
     */
    public static function listLogins($query, $nav, \CRestServer $server): array
    {
        Loader::includeModule('rest');

        $navData = static::getNavData($nav, true);
        $limit = (int)($navData['limit'] ?? 50);
        $offset = (int)($navData['offset'] ?? 0);

        $filter = ['=ACTIVE' => 'Y'];
        if (!empty($query['filter']) && is_array($query['filter'])) {
            foreach ($query['filter'] as $key => $value) {
                $filter[$key] = $value;
            }
        }

        $res = UserTable::getList([
            'filter' => $filter,
            'select' => ['ID', 'LOGIN', 'NAME', 'LAST_NAME'],
            'order' => ['ID' => 'ASC'],
            'limit' => $limit,
            'offset' => $offset,
            'count_total' => true,
        ]);

        $rows = [];
        while ($user = $res->fetch()) {
            $login = isset($user['LOGIN']) ? trim((string)$user['LOGIN']) : '';
            if ($login === '') {
                continue;
            }
            $rows[] = [
                'ID' => (string)$user['ID'],
                'LOGIN' => $login,
                'NAME' => isset($user['NAME']) ? (string)$user['NAME'] : '',
                'LAST_NAME' => isset($user['LAST_NAME']) ? (string)$user['LAST_NAME'] : '',
            ];
        }

        return static::setNavData(
            $rows,
            [
                'count' => $res->getCount(),
                'offset' => $offset,
            ]
        );
    }
}
